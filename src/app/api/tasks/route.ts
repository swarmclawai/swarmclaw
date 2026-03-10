import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { perf } from '@/lib/server/runtime/perf'
import { deleteTask, loadAgents, loadSettings, loadTasks, logActivity, upsertTask } from '@/lib/server/storage'
import { TaskCreateSchema, formatZodError } from '@/lib/validation/schemas'
import { z } from 'zod'
import { enqueueTask, recoverStalledRunningTasks, validateCompletedTasksQueue } from '@/lib/server/runtime/queue'
import { pushMainLoopEventToMainSessions } from '@/lib/server/agents/main-agent-loop'
import { notify } from '@/lib/server/ws-hub'
import { resolveTaskAgentFromDescription } from '@/lib/server/tasks/task-mention'
import { validateDag } from '@/lib/server/dag-validation'
import { getPluginManager } from '@/lib/server/plugins'
import {
  prepareTaskCreation,
} from '@/lib/server/tasks/task-service'
import '@/lib/server/builtin-plugins'

export async function GET(req: Request) {
  const endPerf = perf.start('api', 'GET /api/tasks')
  // Keep completed queue integrity even if daemon is not running.
  validateCompletedTasksQueue()
  recoverStalledRunningTasks()

  const { searchParams } = new URL(req.url)
  const includeArchived = searchParams.get('includeArchived') === 'true'
  const allTasks = loadTasks()

  if (includeArchived) {
    endPerf({ count: Object.keys(allTasks).length })
    return NextResponse.json(allTasks)
  }

  // Exclude archived tasks by default
  const filtered: Record<string, typeof allTasks[string]> = {}
  for (const [id, task] of Object.entries(allTasks)) {
    if (task.status !== 'archived') {
      filtered[id] = task
    }
  }
  endPerf({ count: Object.keys(filtered).length })
  return NextResponse.json(filtered)
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url)
  const filter = searchParams.get('filter') // 'all' | 'schedule' | 'done' | null
  const tasks = loadTasks()
  let removed = 0

  const shouldRemove = (task: { status: string; sourceType?: string }) =>
    filter === 'all' ||
    (filter === 'schedule' && task.sourceType === 'schedule') ||
    (filter === 'done' && (task.status === 'completed' || task.status === 'failed')) ||
    (!filter && task.status === 'archived')

  for (const [id, task] of Object.entries(tasks)) {
    if (shouldRemove(task as { status: string; sourceType?: string })) {
      deleteTask(id)
      removed++
    }
  }
  notify('tasks')
  return NextResponse.json({ removed, remaining: Object.keys(tasks).length - removed })
}

export async function POST(req: Request) {
  const raw = await req.json()
  const parsed = TaskCreateSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
  }
  const body = { ...raw, ...parsed.data }
  const id = genId()
  const now = Date.now()
  const tasks = loadTasks()
  const settings = loadSettings()
  const maxAttempts = Number.isFinite(Number(body.maxAttempts))
    ? Math.max(1, Math.min(20, Math.trunc(Number(body.maxAttempts))))
    : Math.max(1, Math.min(20, Math.trunc(Number(settings.defaultTaskMaxAttempts ?? 3))))
  const retryBackoffSec = Number.isFinite(Number(body.retryBackoffSec))
    ? Math.max(1, Math.min(3600, Math.trunc(Number(body.retryBackoffSec))))
    : Math.max(1, Math.min(3600, Math.trunc(Number(settings.taskRetryBackoffSec ?? 30))))
  // DAG validation: reject if proposed blockedBy would create a cycle
  if (Array.isArray(body.blockedBy) && body.blockedBy.length > 0) {
    const dagResult = validateDag(tasks, id, body.blockedBy)
    if (!dagResult.valid) {
      return NextResponse.json(
        { error: 'Dependency cycle detected', cycle: dagResult.cycle },
        { status: 400 },
      )
    }
  }

  // Resolve @mentions in description to auto-assign agent
  const resolvedAgentId = body.description
    ? resolveTaskAgentFromDescription(body.description, body.agentId || '', loadAgents())
    : (body.agentId || '')

  const prepared = prepareTaskCreation({
    id,
    input: {
      ...body,
      agentId: resolvedAgentId,
    },
    tasks,
    now,
    settings,
    seed: {
      projectId: typeof body.projectId === 'string' && body.projectId ? body.projectId : null,
      goalContract: body.goalContract || null,
      cwd: typeof body.cwd === 'string' ? body.cwd : null,
      file: typeof body.file === 'string' ? body.file : null,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
      result: typeof body.result === 'string' ? body.result : null,
      error: typeof body.error === 'string' ? body.error : null,
      outputFiles: Array.isArray(body.outputFiles)
        ? body.outputFiles.filter((entry: unknown) => typeof entry === 'string').slice(0, 24)
        : [],
      artifacts: Array.isArray(body.artifacts)
        ? body.artifacts
            .filter((artifact: unknown) => artifact && typeof artifact === 'object')
            .map((artifact: unknown) => {
              const row = artifact as {
                url?: unknown
                type?: unknown
                filename?: unknown
              }
              const normalizedType = String(row.type || '')
              return {
                url: String(row.url || ''),
                type: ['image', 'video', 'pdf', 'file'].includes(normalizedType)
                  ? (normalizedType as 'image' | 'video' | 'pdf' | 'file')
                  : 'file',
                filename: String(row.filename || ''),
              }
            })
            .filter((artifact: { url: string; filename: string }) => artifact.url && artifact.filename)
            .slice(0, 24)
        : [],
      archivedAt: null,
      attempts: 0,
      maxAttempts,
      retryBackoffSec,
      retryScheduledAt: null,
      deadLetteredAt: null,
      checkpoint: null,
      blockedBy: Array.isArray(body.blockedBy) ? body.blockedBy.filter((s: unknown) => typeof s === 'string') : [],
      blocks: Array.isArray(body.blocks) ? body.blocks.filter((s: unknown) => typeof s === 'string') : [],
      tags: Array.isArray(body.tags) ? body.tags.filter((s: unknown) => typeof s === 'string') : [],
      dueAt: typeof body.dueAt === 'number' ? body.dueAt : null,
      customFields: body.customFields && typeof body.customFields === 'object' ? body.customFields : undefined,
      priority: ['low', 'medium', 'high', 'critical'].includes(body.priority) ? body.priority : undefined,
    },
  })
  if (!prepared.ok) {
    return NextResponse.json({ error: prepared.error }, { status: 400 })
  }

  if (prepared.duplicate) {
    return NextResponse.json({ ...prepared.duplicate, deduplicated: true })
  }

  const task = prepared.task
  if (task.status === 'completed') {
    const agentPlugins = resolvedAgentId ? (loadAgents()[resolvedAgentId]?.plugins || []) : []
    getPluginManager().runHook(
      'onTaskComplete',
      { taskId: id, result: task.result },
      { enabledIds: agentPlugins },
    )
  }

  upsertTask(id, task)
  logActivity({ entityType: 'task', entityId: id, action: 'created', actor: 'user', summary: `Task created: "${task.title}"` })
  pushMainLoopEventToMainSessions({
    type: 'task_created',
    text: `Task created: "${task.title}" (${id}) with status ${task.status}.`,
  })
  if (task.status === 'queued') {
    enqueueTask(id)
  }
  notify('tasks')
  return NextResponse.json(task)
}
