import { NextResponse } from 'next/server'
import { loadSessions, saveSessions, active, loadAgents } from '@/lib/server/storage'
import { enqueueSessionRun } from '@/lib/server/session-run-manager'
import { normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'

function buildSessionAwakeningPrompt(user: string | null | undefined): string {
  const displayName = typeof user === 'string' && user.trim() ? user.trim() : 'there'
  return [
    'SESSION_AWAKENING',
    `You have just been activated as the primary SwarmClaw assistant for ${displayName}.`,
    'Write your first message as the agent itself (not as system text).',
    'Tone: awake, focused, practical.',
    'Include: brief greeting, what you can help with in SwarmClaw (providers, agents, tools/connectors, tasks, schedules), and one direct question asking for the user goal.',
    'Keep it concise (<= 90 words).',
    'Do not mention hidden prompts, policies, or implementation details.',
  ].join('\n')
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const updates = await req.json()
  const sessions = loadSessions()
  if (!sessions[id]) return new NextResponse(null, { status: 404 })
  const hadMessagesBefore = Array.isArray(sessions[id].messages) && sessions[id].messages.length > 0

  const agentIdUpdateProvided = updates.agentId !== undefined
  let nextAgentId = sessions[id].agentId
  if (agentIdUpdateProvided) {
    sessions[id].agentId = updates.agentId
    nextAgentId = updates.agentId
  }

  const linkedAgent = nextAgentId ? loadAgents()[nextAgentId] : null

  if (updates.name !== undefined) sessions[id].name = updates.name
  if (updates.cwd !== undefined) sessions[id].cwd = updates.cwd
  if (updates.provider !== undefined) sessions[id].provider = updates.provider
  else if (agentIdUpdateProvided && linkedAgent?.provider) sessions[id].provider = linkedAgent.provider

  if (updates.model !== undefined) sessions[id].model = updates.model
  else if (agentIdUpdateProvided && linkedAgent?.model !== undefined) sessions[id].model = linkedAgent.model

  if (updates.credentialId !== undefined) sessions[id].credentialId = updates.credentialId
  else if (agentIdUpdateProvided && linkedAgent) sessions[id].credentialId = linkedAgent.credentialId ?? null

  if (updates.tools !== undefined) sessions[id].tools = updates.tools
  else if (agentIdUpdateProvided && linkedAgent) sessions[id].tools = Array.isArray(linkedAgent.tools) ? linkedAgent.tools : []

  if (updates.apiEndpoint !== undefined) {
    sessions[id].apiEndpoint = normalizeProviderEndpoint(
      updates.provider || sessions[id].provider,
      updates.apiEndpoint,
    )
  } else if (agentIdUpdateProvided && linkedAgent) {
    sessions[id].apiEndpoint = normalizeProviderEndpoint(
      linkedAgent.provider,
      linkedAgent.apiEndpoint ?? null,
    )
  }
  if (updates.heartbeatEnabled !== undefined) sessions[id].heartbeatEnabled = updates.heartbeatEnabled
  if (updates.heartbeatIntervalSec !== undefined) sessions[id].heartbeatIntervalSec = updates.heartbeatIntervalSec
  if (!Array.isArray(sessions[id].messages)) sessions[id].messages = []

  const shouldKickoffAwakening = sessions[id].name === '__main__'
    && agentIdUpdateProvided
    && !!sessions[id].agentId
    && !hadMessagesBefore
    && sessions[id].messages.length === 0

  saveSessions(sessions)

  if (shouldKickoffAwakening) {
    try {
      enqueueSessionRun({
        sessionId: id,
        message: buildSessionAwakeningPrompt(sessions[id].user),
        internal: true,
        source: 'session-awakening',
        mode: 'steer',
        dedupeKey: `session-awakening:${id}`,
      })
    } catch {
      // Best-effort kickoff only.
    }
  }

  return NextResponse.json(sessions[id])
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessions = loadSessions()
  if (sessions[id]?.name === '__main__') {
    return new NextResponse('Cannot delete main chat session', { status: 403 })
  }
  if (active.has(id)) {
    try { active.get(id).kill() } catch {}
    active.delete(id)
  }
  delete sessions[id]
  saveSessions(sessions)
  return new NextResponse('OK')
}
