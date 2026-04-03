import { genId } from '@/lib/id'
import { log } from '@/lib/server/logger'
import { getAgent, listAgents } from '@/lib/server/agents/agent-repository'
import { saveSession } from '@/lib/server/sessions/session-repository'
import { upsertTask } from '@/lib/server/tasks/task-repository'
import { enqueueTask } from '@/lib/server/runtime/queue'
import { loadTasks, loadTask } from '@/lib/server/tasks/task-repository'
import { notify } from '@/lib/server/ws-hub'
import { a2aRouter } from './json-rpc-router'
import type { A2AContext, A2ATaskStatus } from './types'
import type { Session } from '@/types/session'
import type { BoardTask, BoardTaskStatus } from '@/types/task'
import { loadExternalAgents } from '@/lib/server/storage'

const TAG = 'a2a-handlers'

// --- Status mapping ---

function mapTaskStatus(status: BoardTaskStatus): A2ATaskStatus {
  switch (status) {
    case 'queued': case 'backlog': return 'submitted'
    case 'running': return 'working'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'cancelled': case 'archived': case 'deferred': return 'cancelled'
    default: return 'submitted'
  }
}

function findTaskByA2AId(a2aTaskId: string): BoardTask | null {
  // Try direct lookup first (if the A2A taskId IS the SwarmClaw task ID)
  const direct = loadTask(a2aTaskId)
  if (direct) return direct

  // Search by externalSource.id
  const allTasks = loadTasks()
  for (const task of Object.values(allTasks)) {
    if (task.externalSource?.source === 'a2a' && task.externalSource?.id === a2aTaskId) {
      return task
    }
  }
  return null
}

// --- executeTask ---

a2aRouter.register('executeTask', async (params: Record<string, unknown>, context: A2AContext) => {
  const taskId = (params.taskId as string) || genId(8)
  const taskName = (params.taskName as string) || 'A2A Task'
  const taskMessage = (params.message as string) || (params.description as string) || ''
  const agentId = context.agentId || (params.agentId as string)

  if (!agentId) {
    throw new Error('No target agentId specified — provide x-a2a-target-agent-id header or agentId in params')
  }

  const agent = getAgent(agentId)
  if (!agent) {
    throw new Error(`Agent "${agentId}" not found`)
  }

  // Create a session for this A2A task
  const sessionId = genId(8)
  const nowMs = Date.now()
  const session: Session = {
    id: sessionId,
    name: `A2A: ${taskName}`,
    cwd: process.cwd(),
    user: `a2a:${context.requesterId}`,
    provider: agent.provider,
    model: agent.model,
    credentialId: agent.credentialId ?? null,
    claudeSessionId: null,
    messages: [],
    createdAt: nowMs,
    lastActiveAt: nowMs,
    agentId: agent.id,
    tools: agent.tools,
    extensions: agent.extensions,
  }
  saveSession(sessionId, session)

  // Create a BoardTask for tracking
  const boardTaskId = genId()
  const boardTask: BoardTask = {
    id: boardTaskId,
    title: taskName,
    description: taskMessage,
    status: 'queued',
    agentId: agent.id,
    sessionId,
    externalSource: { source: 'a2a', id: taskId },
    queuedAt: nowMs,
    createdAt: nowMs,
    updatedAt: nowMs,
  }
  upsertTask(boardTaskId, boardTask)
  enqueueTask(boardTaskId)
  notify('tasks')

  log.info(TAG, `executeTask: created task ${boardTaskId} for agent ${agentId}`, { a2aTaskId: taskId, sessionId })

  return {
    taskId,
    boardTaskId,
    sessionId,
    status: 'submitted' as const,
    progressUrl: `/api/a2a/tasks/${boardTaskId}/status`,
  }
})

// --- getStatus ---

a2aRouter.register('getStatus', async (params: Record<string, unknown>) => {
  const taskId = params.taskId as string
  if (!taskId) throw new Error('taskId is required')

  const task = findTaskByA2AId(taskId)
  if (!task) throw new Error(`Task "${taskId}" not found`)

  return {
    taskId,
    boardTaskId: task.id,
    sessionId: task.sessionId ?? null,
    status: mapTaskStatus(task.status),
    title: task.title,
    result: task.status === 'completed' ? (task.result ?? null) : null,
    error: task.status === 'failed' ? (task.error ?? null) : null,
    updatedAt: task.updatedAt,
  }
})

// --- cancelTask ---

a2aRouter.register('cancelTask', async (params: Record<string, unknown>) => {
  const taskId = params.taskId as string
  if (!taskId) throw new Error('taskId is required')

  const task = findTaskByA2AId(taskId)
  if (!task) throw new Error(`Task "${taskId}" not found`)

  upsertTask(task.id, { ...task, status: 'cancelled', updatedAt: Date.now() })
  notify('tasks')

  log.info(TAG, `cancelTask: cancelled task ${task.id}`, { a2aTaskId: taskId })

  return { taskId, status: 'cancelled' as const }
})

// --- discoverAgents ---

a2aRouter.register('discoverAgents', async () => {
  const agents = listAgents()
  const localAgents = Object.values(agents)
    .filter(a => !a.disabled)
    .map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
      capabilities: a.capabilities ?? [],
      source: 'local' as const,
    }))

  // Include discovered A2A external agents
  const externalAgents = Object.values(loadExternalAgents())
    .filter(ea => ea.sourceType === 'a2a' && ea.status !== 'offline')
    .map(ea => ({
      id: ea.id,
      name: ea.name,
      description: ea.a2aCard?.apiEndpoint ?? ea.endpoint ?? '',
      capabilities: ea.capabilities ?? [],
      source: 'a2a' as const,
    }))

  return { agents: [...localAgents, ...externalAgents] }
})
