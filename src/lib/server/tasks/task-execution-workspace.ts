import fs from 'fs'
import path from 'path'

import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import type {
  BoardTask,
  TaskExecutionWorkspace,
  TaskLivenessSnapshot,
  TaskPreviewLink,
  TaskRuntimeContextPacket,
  TaskRuntimeEnvHint,
  TaskRuntimeService,
} from '@/types'

const DEFAULT_STALE_RUNNING_MS = 30 * 60 * 1000
const MAX_PREVIEW_LINKS = 12
const MAX_RUNTIME_SERVICES = 12

type PreviewInput = Partial<Omit<TaskPreviewLink, 'id' | 'addedAt'>> & {
  id?: unknown
  label?: unknown
  url?: unknown
  kind?: unknown
  port?: unknown
}

type RuntimeServiceInput = Partial<Omit<TaskRuntimeService, 'id' | 'updatedAt'>> & {
  id?: unknown
  name?: unknown
  status?: unknown
  command?: unknown
  url?: unknown
  port?: unknown
  startedAt?: unknown
}

export interface PrepareTaskExecutionWorkspaceOptions {
  now?: number
  actor?: string | null
  workspaceRoot?: string
  previewLinks?: PreviewInput[]
  runtimeServices?: RuntimeServiceInput[]
  tasks?: Record<string, BoardTask>
}

export interface TaskExecutionWorkspacePatch {
  executionWorkspace: TaskExecutionWorkspace
  previewLinks: TaskPreviewLink[]
  runtimeServices: TaskRuntimeService[]
  liveness: TaskLivenessSnapshot
}

function compactText(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return ''
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.slice(0, maxLen)
}

function stableIdFrom(value: string): string {
  let hash = 5381
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i)
  }
  return Math.abs(hash >>> 0).toString(36)
}

export function taskWorkspaceSlug(task: Pick<BoardTask, 'id' | 'title'>): string {
  const raw = `${task.id} ${task.title || 'task'}`
  let out = ''
  let lastWasDash = false
  for (const char of raw.toLowerCase()) {
    const isAlpha = char >= 'a' && char <= 'z'
    const isDigit = char >= '0' && char <= '9'
    if (isAlpha || isDigit) {
      out += char
      lastWasDash = false
      continue
    }
    if (!lastWasDash && out) {
      out += '-'
      lastWasDash = true
    }
  }
  const trimmed = out.replace(/-+$/g, '')
  return (trimmed || `task-${task.id}`).slice(0, 96)
}

function normalizePort(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN
  if (!Number.isFinite(parsed)) return null
  const port = Math.trunc(parsed)
  return port > 0 && port < 65536 ? port : null
}

function normalizePreviewKind(value: unknown): TaskPreviewLink['kind'] {
  return value === 'api' || value === 'docs' || value === 'custom' ? value : 'web'
}

export function normalizeTaskPreviewLinks(
  existing: TaskPreviewLink[] | undefined,
  incoming: PreviewInput[] | undefined,
  now = Date.now(),
): TaskPreviewLink[] {
  const out: TaskPreviewLink[] = []
  const seenUrls = new Set<string>()

  const append = (link: PreviewInput | TaskPreviewLink) => {
    const url = compactText(link.url, 2048)
    if (!url || seenUrls.has(url)) return
    seenUrls.add(url)
    const label = compactText(link.label, 80) || 'Preview'
    const port = normalizePort(link.port)
    out.push({
      id: compactText(link.id, 80) || `preview-${stableIdFrom(url)}`,
      label,
      url,
      kind: normalizePreviewKind(link.kind),
      port,
      addedAt: typeof (link as TaskPreviewLink).addedAt === 'number' && Number.isFinite((link as TaskPreviewLink).addedAt)
        ? (link as TaskPreviewLink).addedAt
        : now,
    })
  }

  for (const link of existing || []) append(link)
  for (const link of incoming || []) append(link)
  return out.slice(0, MAX_PREVIEW_LINKS)
}

function normalizeRuntimeStatus(value: unknown): TaskRuntimeService['status'] {
  return value === 'running' || value === 'stopped' || value === 'failed' || value === 'unknown'
    ? value
    : 'planned'
}

export function normalizeTaskRuntimeServices(
  existing: TaskRuntimeService[] | undefined,
  incoming: RuntimeServiceInput[] | undefined,
  now = Date.now(),
): TaskRuntimeService[] {
  const out: TaskRuntimeService[] = []
  const seenKeys = new Set<string>()

  const append = (service: RuntimeServiceInput | TaskRuntimeService) => {
    const name = compactText(service.name, 100)
    const url = compactText(service.url, 2048) || null
    const port = normalizePort(service.port)
    const command = compactText(service.command, 500) || null
    const key = `${name || 'service'}:${url || ''}:${port || ''}`
    if (seenKeys.has(key)) return
    seenKeys.add(key)
    out.push({
      id: compactText(service.id, 80) || `service-${stableIdFrom(key)}`,
      name: name || 'Runtime service',
      status: normalizeRuntimeStatus(service.status),
      command,
      url,
      port,
      startedAt: typeof service.startedAt === 'number' && Number.isFinite(service.startedAt) ? service.startedAt : null,
      updatedAt: typeof (service as TaskRuntimeService).updatedAt === 'number' && Number.isFinite((service as TaskRuntimeService).updatedAt)
        ? (service as TaskRuntimeService).updatedAt
        : now,
    })
  }

  for (const service of existing || []) append(service)
  for (const service of incoming || []) append(service)
  return out.slice(0, MAX_RUNTIME_SERVICES)
}

function taskWorkspaceRoot(task: BoardTask, workspaceRoot: string): string {
  if (task.projectId) return path.join(workspaceRoot, 'projects', task.projectId, 'task-workspaces')
  return path.join(workspaceRoot, 'task-workspaces')
}

function writeWorkspaceReadme(task: BoardTask, workspacePath: string, now: number): string {
  const readmePath = path.join(workspacePath, 'README.md')
  const lines = [
    `# ${task.title || 'Task Workspace'}`,
    '',
    `Task ID: ${task.id}`,
    `Status: ${task.status}`,
    `Prepared: ${new Date(now).toISOString()}`,
  ]
  if (task.projectId) lines.push(`Project ID: ${task.projectId}`)
  if (task.cwd) lines.push(`Source cwd: ${task.cwd}`)
  lines.push(
    '',
    'Runtime context: ./context.json',
    'Environment hints: ./.env.swarmclaw',
    '',
    'Use this directory for task-local notes, generated artifacts, and preview handoff files.',
  )
  fs.writeFileSync(readmePath, `${lines.join('\n')}\n`, 'utf8')
  return readmePath
}

function addEnvHint(out: TaskRuntimeEnvHint[], key: string, value: unknown, description?: string) {
  if (typeof value !== 'string' || !value) return
  out.push({ key, value, ...(description ? { description } : {}) })
}

function buildRuntimeEnvHints(params: {
  task: BoardTask
  workspacePath: string
  sourceCwd?: string | null
  mode: TaskExecutionWorkspace['mode']
  contextPath: string
  envPath: string
}): TaskRuntimeEnvHint[] {
  const { task, workspacePath, sourceCwd, mode, contextPath, envPath } = params
  const hints: TaskRuntimeEnvHint[] = []
  const workspaceId = taskWorkspaceSlug(task)
  addEnvHint(hints, 'SWARMCLAW_TASK_ID', task.id, 'SwarmClaw task id')
  addEnvHint(hints, 'SWARMCLAW_TASK_TITLE', task.title || 'Task', 'SwarmClaw task title')
  addEnvHint(hints, 'SWARMCLAW_TASK_STATUS', task.status, 'SwarmClaw task status')
  addEnvHint(hints, 'SWARMCLAW_TASK_AGENT_ID', task.agentId, 'Assigned SwarmClaw agent id')
  addEnvHint(hints, 'SWARMCLAW_WORKSPACE_ID', workspaceId, 'Stable task workspace id')
  addEnvHint(hints, 'SWARMCLAW_WORKSPACE_CWD', workspacePath, 'Task workspace directory')
  addEnvHint(hints, 'SWARMCLAW_WORKSPACE_MODE', mode, 'Task workspace mode')
  addEnvHint(hints, 'SWARMCLAW_WORKSPACE_CONTEXT', contextPath, 'Runtime context packet path')
  addEnvHint(hints, 'SWARMCLAW_WORKSPACE_ENV', envPath, 'Reusable runtime env file')
  addEnvHint(hints, 'SWARMCLAW_PROJECT_ID', task.projectId || '', 'SwarmClaw project id')
  addEnvHint(hints, 'SWARMCLAW_SOURCE_CWD', sourceCwd || '', 'Original source directory')
  addEnvHint(hints, 'AGENT_HOME', workspacePath, 'Agent-local home directory')
  addEnvHint(hints, 'TASK_ID', task.id, 'Portable task id')
  addEnvHint(hints, 'TASK_TITLE', task.title || 'Task', 'Portable task title')
  addEnvHint(hints, 'WORKSPACE_ID', workspaceId, 'Portable workspace id')
  addEnvHint(hints, 'WORKSPACE_CWD', workspacePath, 'Portable workspace cwd')
  addEnvHint(hints, 'WORKSPACE_SOURCE', sourceCwd || workspacePath, 'Portable source path')
  addEnvHint(
    hints,
    'WORKSPACE_STRATEGY',
    mode === 'project' ? 'project-task-workspace' : 'task-workspace',
    'Portable workspace strategy',
  )
  addEnvHint(hints, 'KANBAN_TASK_ID', task.id, 'Portable board task id')
  addEnvHint(hints, 'KANBAN_WORKSPACE', workspacePath, 'Portable board workspace path')
  return hints
}

function envLine(hint: TaskRuntimeEnvHint): string {
  return `${hint.key}=${JSON.stringify(hint.value)}`
}

function writeWorkspaceEnv(envPath: string, hints: TaskRuntimeEnvHint[]) {
  const lines = [
    '# Generated by SwarmClaw. Contains task context only, not secrets.',
    ...hints.map(envLine),
  ]
  fs.writeFileSync(envPath, `${lines.join('\n')}\n`, 'utf8')
}

function buildTaskRuntimeContext(params: {
  task: BoardTask
  executionWorkspace: Omit<TaskExecutionWorkspace, 'context'>
  previewLinks: TaskPreviewLink[]
  runtimeServices: TaskRuntimeService[]
  generatedAt: number
}): TaskRuntimeContextPacket {
  const { task, executionWorkspace, previewLinks, runtimeServices, generatedAt } = params
  return {
    taskId: task.id,
    title: task.title || 'Task',
    description: task.description || undefined,
    status: task.status,
    agentId: task.agentId,
    projectId: executionWorkspace.projectId || null,
    workspacePath: executionWorkspace.path,
    sourceCwd: executionWorkspace.sourceCwd || null,
    mode: executionWorkspace.mode,
    preparedAt: executionWorkspace.preparedAt,
    generatedAt,
    previewLinks,
    runtimeServices,
    blockedBy: task.blockedBy,
    blocks: task.blocks,
    tags: task.tags,
    upstreamResults: task.upstreamResults,
  }
}

function writeWorkspaceContext(contextPath: string, context: TaskRuntimeContextPacket) {
  fs.writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`, 'utf8')
}

export function computeTaskLiveness(
  task: BoardTask,
  tasks: Record<string, BoardTask> = {},
  options: { now?: number; staleAfterMs?: number } = {},
): TaskLivenessSnapshot {
  const now = options.now ?? Date.now()
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_RUNNING_MS
  const lastActivityAt = task.lastActivityAt ?? task.updatedAt ?? task.startedAt ?? task.createdAt ?? null
  const blockerTaskIds = (task.blockedBy || [])
    .filter((id) => {
      const blocker = tasks[id]
      return !blocker || blocker.status !== 'completed'
    })

  if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'archived') {
    return {
      state: task.status,
      reason: `Task is ${task.status}.`,
      checkedAt: now,
      lastActivityAt,
    }
  }

  if (task.deadLetteredAt) {
    return {
      state: 'dead_lettered',
      reason: 'Retry budget was exhausted.',
      checkedAt: now,
      lastActivityAt,
    }
  }

  if (blockerTaskIds.length > 0) {
    return {
      state: 'blocked',
      reason: `Waiting on ${blockerTaskIds.length} blocker${blockerTaskIds.length === 1 ? '' : 's'}.`,
      checkedAt: now,
      lastActivityAt,
      blockerTaskIds,
    }
  }

  if (task.retryScheduledAt && task.retryScheduledAt > now) {
    return {
      state: 'retrying',
      reason: 'Retry is scheduled.',
      checkedAt: now,
      lastActivityAt,
      nextWakeAt: task.retryScheduledAt,
    }
  }

  if (task.status === 'running') {
    const staleMs = lastActivityAt ? now - lastActivityAt : null
    if (staleMs !== null && staleMs > staleAfterMs) {
      return {
        state: 'stale',
        reason: `No activity for ${Math.round(staleMs / 60000)} minute${Math.round(staleMs / 60000) === 1 ? '' : 's'}.`,
        checkedAt: now,
        lastActivityAt,
        staleMs,
      }
    }
    return {
      state: 'running',
      reason: 'Task is checked out and running.',
      checkedAt: now,
      lastActivityAt,
    }
  }

  if (task.status === 'queued') {
    return {
      state: 'queued',
      reason: 'Ready in the execution queue.',
      checkedAt: now,
      lastActivityAt,
    }
  }

  return {
    state: task.executionWorkspace ? 'ready' : 'not_started',
    reason: task.executionWorkspace ? 'Workspace is prepared.' : 'No execution workspace has been prepared yet.',
    checkedAt: now,
    lastActivityAt,
  }
}

export function prepareTaskExecutionWorkspace(
  task: BoardTask,
  options: PrepareTaskExecutionWorkspaceOptions = {},
): TaskExecutionWorkspacePatch {
  const now = options.now ?? Date.now()
  const workspaceRoot = options.workspaceRoot || WORKSPACE_DIR
  const existing = task.executionWorkspace || null
  const workspacePath = existing?.path || path.join(taskWorkspaceRoot(task, workspaceRoot), taskWorkspaceSlug(task))
  fs.mkdirSync(workspacePath, { recursive: true })
  const contextPath = path.join(workspacePath, 'context.json')
  const envPath = path.join(workspacePath, '.env.swarmclaw')
  const readmePath = writeWorkspaceReadme(task, workspacePath, now)
  const previewLinks = normalizeTaskPreviewLinks(
    task.previewLinks || existing?.previewLinks,
    options.previewLinks,
    now,
  )
  const runtimeServices = normalizeTaskRuntimeServices(
    task.runtimeServices || existing?.runtimeServices,
    options.runtimeServices,
    now,
  )
  const mode: TaskExecutionWorkspace['mode'] = task.projectId ? 'project' : 'task'
  const sourceCwd = task.cwd || existing?.sourceCwd || null
  const projectId = task.projectId || existing?.projectId || null
  const preparedAt = existing?.preparedAt || now
  const envHints = buildRuntimeEnvHints({
    task,
    workspacePath,
    sourceCwd,
    mode,
    contextPath,
    envPath,
  })
  const executionWorkspaceBase: Omit<TaskExecutionWorkspace, 'context'> = {
    path: workspacePath,
    mode,
    sourceCwd,
    projectId,
    preparedAt,
    preparedBy: options.actor || existing?.preparedBy || null,
    readmePath,
    contextPath,
    envPath,
    envHints,
    previewLinks,
    runtimeServices,
  }
  const context = buildTaskRuntimeContext({
    task,
    executionWorkspace: executionWorkspaceBase,
    previewLinks,
    runtimeServices,
    generatedAt: now,
  })
  writeWorkspaceContext(contextPath, context)
  writeWorkspaceEnv(envPath, envHints)
  const executionWorkspace: TaskExecutionWorkspace = {
    ...executionWorkspaceBase,
    context,
  }
  const taskForLiveness = {
    ...task,
    executionWorkspace,
    previewLinks,
    runtimeServices,
  }
  return {
    executionWorkspace,
    previewLinks,
    runtimeServices,
    liveness: computeTaskLiveness(taskForLiveness, options.tasks || {}, { now }),
  }
}
