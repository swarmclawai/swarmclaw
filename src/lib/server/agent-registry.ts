import { loadAgents, loadTasks, loadSessions } from './storage'
import type { Agent, BoardTask } from '@/types'

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
  for (const session of Object.values(sessions) as Record<string, unknown>[]) {
    if (session.active && session.agentId) {
      activeSessions.add(session.agentId as string)
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

export function buildAgentAwarenessBlock(excludeId: string): string {
  const directory = getAgentDirectory(excludeId)
  if (!directory.length) return ''

  const lines = directory.map((entry) => {
    const caps = entry.capabilities.length ? ` (${entry.capabilities.join(', ')})` : ''
    const status = entry.statusDetail || entry.status
    return `- **${entry.name}** [id: ${entry.id}]${caps} — ${status}`
  })

  return [
    '## Available Agents',
    ...lines,
    'You can delegate tasks to any agent using the delegate_to_agent tool.',
  ].join('\n')
}
