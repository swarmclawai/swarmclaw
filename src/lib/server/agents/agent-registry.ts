import type { Agent, BoardTask } from '@/types'
import { loadAgents } from '@/lib/server/agents/agent-repository'
import { loadSessions } from '@/lib/server/sessions/session-repository'
import { loadTasks } from '@/lib/server/tasks/task-repository'

export interface AgentDirectoryEntry {
  id: string
  name: string
  description: string
  capabilities: string[]
  status: 'idle' | 'working'
  statusDetail?: string
}

export function getAgentDirectory(excludeId?: string): AgentDirectoryEntry[] {
  const agents = loadAgents() as Record<string, Agent>
  const tasks = loadTasks() as Record<string, BoardTask>
  const sessions = loadSessions()

  // Find running tasks per agent
  const runningTasks = new Map<string, string>()
  for (const task of Object.values(tasks)) {
    if (task.status === 'running' && task.agentId) {
      runningTasks.set(task.agentId, task.title)
    }
  }

  // Find active sessions per agent
  const activeSessions = new Set<string>()
  for (const session of Object.values(sessions)) {
    if (session.active && session.agentId) {
      activeSessions.add(session.agentId)
    }
  }

  const entries: AgentDirectoryEntry[] = []
  for (const agent of Object.values(agents)) {
    if (excludeId && agent.id === excludeId) continue

    const runningTask = runningTasks.get(agent.id)
    const isActive = activeSessions.has(agent.id)
    const isWorking = !!runningTask || isActive

    entries.push({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      capabilities: agent.capabilities || [],
      status: isWorking ? 'working' : 'idle',
      statusDetail: runningTask ? `working on: ${runningTask}` : undefined,
    })
  }

  return entries
}

export function buildAgentAwarenessBlock(
  excludeId: string,
  opts?: {
    delegationTargetMode?: 'all' | 'selected'
    delegationTargetAgentIds?: string[]
  },
): string {
  let directory = getAgentDirectory(excludeId)
  if (!directory.length) return ''

  const isFiltered = opts?.delegationTargetMode === 'selected'
  if (isFiltered) {
    const allowedIds = new Set(opts.delegationTargetAgentIds || [])
    directory = directory.filter((entry) => allowedIds.has(entry.id))
    if (!directory.length) return ''
  }

  const lines = directory.map((entry) => {
    const caps = entry.capabilities.length ? ` (${entry.capabilities.join(', ')})` : ''
    const status = entry.statusDetail || entry.status
    return `- **${entry.name}** [id: ${entry.id}]${caps} — ${status}`
  })

  const header = isFiltered
    ? 'These are the ONLY agents I can delegate tasks to. Do not attempt to delegate to any other agents:'
    : 'These are the other agents I work alongside. I can hand off tasks to any of them if their skills are a better fit:'

  return [
    '## My Colleagues',
    header,
    ...lines,
  ].join('\n')
}
