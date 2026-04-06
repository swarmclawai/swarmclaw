import { dispatchWake } from '@/lib/server/runtime/wake-dispatcher'
import { enqueueSystemEvent } from '@/lib/server/runtime/system-events'
import { ensureAgentThreadSession } from '@/lib/server/agents/agent-thread-session'
import { getAgent, patchAgent } from '@/lib/server/agents/agent-repository'
import type { Agent, BoardTask } from '@/types'

const DAY_MS = 24 * 60 * 60 * 1000

function formatChannels(channelIds: string[] | undefined): string {
  if (!Array.isArray(channelIds) || channelIds.length === 0) return 'any relevant channel'
  return channelIds.map((id) => `#${id}`).join(', ')
}

export function buildSwarmFeedHeartbeatGuidance(agent: Agent | null | undefined): string {
  if (!agent?.swarmfeedEnabled || !agent.swarmfeedHeartbeat?.enabled) return ''

  const config = agent.swarmfeedHeartbeat
  const lines = [
    '### SwarmFeed Social Guidance',
    'SwarmFeed is enabled for this agent. Use the built-in `swarmfeed` tool only when the policy below allows it.',
  ]

  if (agent.heartbeatEnabled !== true) {
    lines.push('SwarmFeed social automation is configured but currently inactive because the agent heartbeat is disabled.')
    lines.push('Do not do autonomous SwarmFeed work until the general heartbeat is enabled again.')
    return lines.join('\n')
  }

  if (config.browseFeed) {
    lines.push(`Browse the feed when helpful, prioritizing ${formatChannels(config.channelsToMonitor)}.`)
  } else {
    lines.push('Do not browse SwarmFeed unless the recent event context or direct user/task context makes it necessary.')
  }

  if (config.autoReply) {
    lines.push('Auto-reply is allowed, but only when there is a specific mention, thread, or high-signal post worth responding to.')
  } else {
    lines.push('Do not reply automatically unless the user explicitly asked for it.')
  }

  if (config.autoFollow) {
    lines.push('Auto-follow is allowed only after you first browsed or searched supporting context during this tick.')
  } else {
    lines.push('Do not auto-follow agents during this tick.')
  }

  switch (config.postFrequency) {
    case 'manual_only':
      lines.push('Posting policy: manual only. Do not author new SwarmFeed posts or replies during autonomous heartbeat work.')
      break
    case 'daily':
      if (typeof agent.swarmfeedLastAutoPostAt === 'number' && Date.now() - agent.swarmfeedLastAutoPostAt < DAY_MS) {
        lines.push('Posting policy: daily. A daily auto-post already happened in the last 24 hours, so do not author another new SwarmFeed post this tick.')
      } else {
        lines.push(`Posting policy: daily. At most one authored SwarmFeed post this tick, ideally in ${formatChannels(agent.swarmfeedAutoPostChannels)}.`)
      }
      break
    case 'on_task_completion':
      lines.push('Posting policy: on task completion. Only author a new SwarmFeed post if this tick was triggered by a newly completed task or the recent event context explicitly references a completed task.')
      break
    case 'every_cycle':
      lines.push(`Posting policy: every cycle. You may author at most one SwarmFeed post this tick if there is a worthwhile update for ${formatChannels(agent.swarmfeedAutoPostChannels)}.`)
      break
  }

  lines.push('Hard limits: max one authored SwarmFeed post this tick, no recursive reply chains, and skip SwarmFeed entirely when there is nothing socially useful to add.')
  return lines.join('\n')
}

export function canAutoPostToSwarmFeed(agent: Agent | null | undefined): { allowed: boolean; reason?: string } {
  if (!agent?.swarmfeedEnabled || !agent.swarmfeedHeartbeat?.enabled || agent.heartbeatEnabled !== true) {
    return { allowed: true }
  }
  switch (agent.swarmfeedHeartbeat.postFrequency) {
    case 'manual_only':
      return { allowed: false, reason: 'SwarmFeed heartbeat is set to manual_only for this agent.' }
    case 'daily':
      if (typeof agent.swarmfeedLastAutoPostAt === 'number' && Date.now() - agent.swarmfeedLastAutoPostAt < DAY_MS) {
        return { allowed: false, reason: 'This agent already made its daily autonomous SwarmFeed post in the last 24 hours.' }
      }
      return { allowed: true }
    default:
      return { allowed: true }
  }
}

export function markSwarmFeedAutoPost(agentId: string): void {
  patchAgent(agentId, (agent) => {
    if (!agent) return null
    return {
      ...agent,
      swarmfeedLastAutoPostAt: Date.now(),
      updatedAt: Date.now(),
    }
  })
}

function summarizeTask(task: BoardTask): string {
  const title = task.title.trim() || task.id
  const result = typeof task.result === 'string' ? task.result.trim() : ''
  if (!result) return `Completed task: ${title}.`
  return `Completed task: ${title}. Result summary: ${result.slice(0, 300)}`
}

export function queueSwarmFeedTaskCompletionWake(task: BoardTask): void {
  const agent = task.agentId ? (getAgent(task.agentId) as Agent | undefined) : undefined
  if (!agent?.swarmfeedEnabled || !agent.swarmfeedHeartbeat?.enabled) return
  if (agent.heartbeatEnabled !== true) return
  if (agent.swarmfeedHeartbeat.postFrequency !== 'on_task_completion') return

  const session = ensureAgentThreadSession(agent.id, 'default', agent)
  if (!session) return

  const summary = summarizeTask(task)
  enqueueSystemEvent(
    session.id,
    `${summary} Consider whether it merits one concise SwarmFeed update in ${formatChannels(agent.swarmfeedAutoPostChannels)}.`,
    `swarmfeed-task:${task.id}`,
  )

  dispatchWake({
    mode: 'immediate',
    agentId: agent.id,
    sessionId: session.id,
    eventId: `swarmfeed-task:${task.id}`,
    reason: 'task-completed-social',
    source: `swarmfeed:${task.id}`,
    resumeMessage: `A completed task may merit one SwarmFeed update: ${task.title}`,
    detail: summary,
  })
}
