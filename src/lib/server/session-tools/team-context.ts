import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { loadAgents, loadTasks, loadSessions } from '../storage'
import { getRecentMessages } from '@/lib/server/messages/message-repository'
import { resolveTeam, resolveReachableAgentIds } from '../agents/team-resolution'
import { getAgentDirectory } from '../agents/agent-registry'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { registerNativeCapability } from '../native-capabilities'
import { log } from '../logger'
import { debug } from '../debug'
import { logExecution } from '../execution-log'
import type { ToolBuildContext } from './context'
import type { Agent, Extension, ExtensionHooks, BoardTask, MemoryEntry } from '@/types'
import { CLI_PROVIDER_CAPABILITIES, isCliProvider } from '@/lib/providers/cli-utils'

const MAX_OUTPUT_CHARS = 4000
const MAX_RECENT_MEMORIES = 5
const MAX_RECENT_ACTIVITY = 3
const ACTIVITY_PREVIEW_CHARS = 200

function formatTeamRoster(agentId: string): string {
  const agents = loadAgents() as Record<string, Agent>
  const team = resolveTeam(agentId, agents)

  if (team.mode === 'flat') {
    return JSON.stringify({
      ok: true,
      mode: 'flat',
      message: 'No org chart hierarchy detected. You are not part of a team.',
      team: [],
    })
  }

  const directory = getAgentDirectory(agentId)
  const directoryMap = new Map(directory.map((e) => [e.id, e]))

  const members: Record<string, unknown>[] = []

  const buildMember = (agent: Agent, role: string) => {
    const entry = directoryMap.get(agent.id)
    const provider = agent.provider || null
    const member: Record<string, unknown> = {
      id: agent.id,
      name: agent.name,
      role,
      status: entry?.status || 'unknown',
      statusDetail: entry?.statusDetail || null,
      provider,
    }
    if (provider && isCliProvider(provider)) {
      member.providerCapabilities = CLI_PROVIDER_CAPABILITIES[provider] || null
    }
    return member
  }

  if (team.coordinator) {
    members.push(buildMember(team.coordinator, 'coordinator'))
  }

  for (const peer of team.peers) {
    members.push(buildMember(peer, 'peer'))
  }

  for (const report of team.directReports) {
    members.push(buildMember(report, 'direct_report'))
  }

  return JSON.stringify({ ok: true, mode: 'team', team: members })
}

async function formatPeerContext(agentId: string, peerId: string): Promise<string> {
  const agents = loadAgents() as Record<string, Agent>

  // Validate peer is reachable
  const reachable = resolveReachableAgentIds(agentId, agents)
  if (!reachable.has(peerId)) {
    const peer = agents[peerId]
    if (!peer) {
      return JSON.stringify({ ok: false, error: `Agent "${peerId}" not found.` })
    }
    return JSON.stringify({
      ok: false,
      error: `Agent "${peer.name}" is not on your team. You can only view context for peers, your coordinator, or direct reports.`,
    })
  }

  const peer = agents[peerId]
  if (!peer) {
    return JSON.stringify({ ok: false, error: `Agent "${peerId}" not found.` })
  }

  const result: Record<string, unknown> = {
    ok: true,
    agent: {
      id: peer.id,
      name: peer.name,
      description: peer.description || null,
      capabilities: peer.capabilities || [],
      role: peer.role || 'worker',
    },
  }

  // Current tasks
  try {
    const tasks = loadTasks() as Record<string, BoardTask>
    const peerTasks = Object.values(tasks)
      .filter((t) => t.agentId === peerId && (t.status === 'running' || t.status === 'queued'))
      .slice(0, 5)
      .map((t) => ({
        title: t.title,
        status: t.status,
        description: t.description ? t.description.slice(0, 150) : null,
      }))
    result.currentTasks = peerTasks
  } catch {
    result.currentTasks = []
  }

  // Recent memories
  try {
    const { getMemoryDb } = await import('../memory/memory-db')
    const memDb = getMemoryDb()
    const memories = memDb.getByAgent(peerId, MAX_RECENT_MEMORIES)
    result.recentMemories = memories.map((m: MemoryEntry) => ({
      content: m.content ? m.content.slice(0, 300) : '',
      category: m.category || null,
      updatedAt: m.updatedAt || null,
    }))
  } catch {
    result.recentMemories = []
  }

  // Load sessions once and reuse for both recent activity and active mission
  let allSessions: ReturnType<typeof loadSessions> | null = null
  try {
    allSessions = loadSessions()
  } catch { /* non-critical */ }

  // Recent activity from latest session
  try {
    const sessions = allSessions || loadSessions()
    const peerSessions = Object.values(sessions)
      .filter((s) => s.agentId === peerId && (s.messageCount ?? 0) > 0)
      .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))

    const latestSession = peerSessions.length > 0 ? peerSessions[0] : null
    if (latestSession) {
      const recentMessages = getRecentMessages(latestSession.id, 20)
        .filter((m) => m.role === 'assistant' && Array.isArray(m.toolEvents) && m.toolEvents.length > 0)
        .slice(-MAX_RECENT_ACTIVITY)
      result.recentActivity = recentMessages.map((m) => {
        const events = (m.toolEvents || []).slice(0, 3).map((e) => ({
          tool: e.name || null,
          preview: typeof e.output === 'string' ? e.output.slice(0, ACTIVITY_PREVIEW_CHARS) : null,
        }))
        return { time: m.time, tools: events }
      })
    } else {
      result.recentActivity = []
    }
  } catch {
    result.recentActivity = []
  }

  // Active mission
  try {
    const sessions = allSessions || loadSessions()
    const activeSession = Object.values(sessions).find(
      (s) => s.agentId === peerId && s.active,
    )
    if (activeSession?.missionId) {
      result.activeMission = { missionId: activeSession.missionId }
    }
  } catch { /* non-critical */ }

  // Enforce output cap — drop large fields instead of slicing mid-JSON
  let output = JSON.stringify(result)
  if (output.length > MAX_OUTPUT_CHARS) {
    result.recentActivity = []
    result.recentMemories = []
    result.note = 'Some fields omitted due to output size limit'
    output = JSON.stringify(result)
  }
  // Final hard-truncation safety net
  if (output.length > MAX_OUTPUT_CHARS) {
    output = output.slice(0, MAX_OUTPUT_CHARS - 15) + '...[truncated]"}'
  }
  return output
}

async function executeTeamContext(
  args: Record<string, unknown>,
  context: { agentId?: string | null },
): Promise<string> {
  const normalized = normalizeToolInputArgs(args)
  const action = normalized.action as string | undefined

  if (!context.agentId) {
    return JSON.stringify({ ok: false, error: 'team_context requires an agent context' })
  }

  if (!action?.trim()) {
    return JSON.stringify({ ok: false, error: 'action is required. Use "list_team" or "peer_context".' })
  }

  const trimmedAction = action.trim()

  log.info('team-context', 'Query', { agentId: context.agentId, action: trimmedAction })
  logExecution(context.agentId, 'coordination', `Team context: ${trimmedAction}`)

  if (trimmedAction === 'list_team' || trimmedAction === 'list') {
    const result = formatTeamRoster(context.agentId)
    debug.verbose('team-context', 'Result', { action: trimmedAction, result })
    return result
  }

  if (trimmedAction === 'peer_context' || trimmedAction === 'peer') {
    const peerId = (normalized.peerId ?? normalized.peer_id ?? normalized.agentId ?? normalized.agent_id) as string | undefined
    if (!peerId?.trim()) {
      return JSON.stringify({ ok: false, error: 'peerId is required for peer_context action.' })
    }
    const result = await formatPeerContext(context.agentId, peerId.trim())
    debug.verbose('team-context', 'Result', { action: trimmedAction, peerId, result })
    return result
  }

  return JSON.stringify({
    ok: false,
    error: `Unknown action "${trimmedAction}". Use "list_team" or "peer_context".`,
  })
}

const TeamContextExtension: Extension = {
  name: 'Team Context',
  description: 'View team peers\' status, focus, and context.',
  hooks: {
    getCapabilityDescription: () =>
      'View team peers\' status, focus, and context (`team_context`). List your team roster or get detailed context on a specific teammate including their tasks, memories, and recent activity.',
  } as ExtensionHooks,
  tools: [
    {
      name: 'team_context',
      description: [
        'View your team\'s status and detailed peer context.',
        'Actions: list_team (team roster with status), peer_context (detailed view of one teammate).',
        'Params: action (required), peerId (required for peer_context).',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list_team', 'peer_context'], description: 'The action to perform' },
          peerId: { type: 'string', description: 'The agent ID to get context for (required for peer_context)' },
        },
        required: ['action'],
      },
      execute: async (args, context) => executeTeamContext(args, { agentId: context.session.agentId }),
    },
  ],
}

registerNativeCapability('team_context', TeamContextExtension)

export function buildTeamContextTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasExtension('team_context')) return []
  return [
    tool(
      async (args) => executeTeamContext(args, { agentId: bctx.ctx?.agentId }),
      {
        name: 'team_context',
        description: TeamContextExtension.tools![0].description,
        schema: z.object({
          action: z.enum(['list_team', 'peer_context']).describe('The action to perform'),
          peerId: z.string().optional().describe('The agent ID to get context for (required for peer_context)'),
        }).passthrough(),
      },
    ),
  ]
}
