import { NextResponse } from 'next/server'
import { loadSessions, saveSessions, deleteSession, active, loadAgents } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const updates = await req.json()
  const sessions = loadSessions()
  if (!sessions[id]) return notFound()

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

  if (updates.plugins !== undefined) sessions[id].plugins = updates.plugins
  else if (agentIdUpdateProvided && linkedAgent) sessions[id].plugins = Array.isArray(linkedAgent.plugins) ? linkedAgent.plugins : []

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
  if (updates.pinned !== undefined) sessions[id].pinned = !!updates.pinned
  if (updates.claudeSessionId !== undefined) sessions[id].claudeSessionId = updates.claudeSessionId
  if (updates.codexThreadId !== undefined) sessions[id].codexThreadId = updates.codexThreadId
  if (updates.opencodeSessionId !== undefined) sessions[id].opencodeSessionId = updates.opencodeSessionId
  if (updates.delegateResumeIds !== undefined) sessions[id].delegateResumeIds = updates.delegateResumeIds
  if (!Array.isArray(sessions[id].messages)) sessions[id].messages = []

  saveSessions(sessions)
  return NextResponse.json(sessions[id])
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessions = loadSessions()
  if (!sessions[id]) return notFound()
  if (active.has(id)) {
    try { active.get(id).kill() } catch {}
    active.delete(id)
  }
  deleteSession(id)
  return new NextResponse('OK')
}
