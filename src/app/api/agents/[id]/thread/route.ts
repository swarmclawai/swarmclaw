import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadAgents, saveAgents, loadSessions, saveSessions } from '@/lib/server/storage'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: agentId } = await params
  const agents = loadAgents()
  const agent = agents[agentId]
  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  const body = await req.json().catch(() => ({}))
  const user = body.user || 'default'
  const sessions = loadSessions()

  // If the agent already has a shortcut chat session, return it.
  if (agent.threadSessionId && sessions[agent.threadSessionId]) {
    const existing = sessions[agent.threadSessionId] as Record<string, unknown>
    let changed = false
    if (existing.shortcutForAgentId !== agentId) {
      existing.shortcutForAgentId = agentId
      changed = true
    }
    if (existing.name !== agent.name) {
      existing.name = agent.name
      changed = true
    }
    if (changed) saveSessions(sessions)
    return NextResponse.json(existing)
  }

  // Legacy fallback for older shortcut sessions that were named using the
  // old agent-thread convention before the explicit link was persisted.
  const existing = Object.values(sessions).find(
    (s: Record<string, unknown>) =>
      (
        s.shortcutForAgentId === agentId
        || s.name === `agent-thread:${agentId}`
      )
      && s.user === user
  )
  if (existing) {
    agent.threadSessionId = (existing as Record<string, unknown>).id as string
    agent.updatedAt = Date.now()
    saveAgents(agents)
    let changed = false
    const existingRecord = existing as Record<string, unknown>
    if (existingRecord.shortcutForAgentId !== agentId) {
      existingRecord.shortcutForAgentId = agentId
      changed = true
    }
    if (existingRecord.name !== agent.name) {
      existingRecord.name = agent.name
      changed = true
    }
    if (changed) saveSessions(sessions)
    return NextResponse.json(existing)
  }

  // Create a new shortcut chat session for this agent.
  const sessionId = `agent-chat-${agentId}-${genId()}`
  const now = Date.now()
  const session = {
    id: sessionId,
    name: agent.name,
    shortcutForAgentId: agentId,
    cwd: WORKSPACE_DIR,
    user: user,
    provider: agent.provider,
    model: agent.model,
    credentialId: agent.credentialId || null,
    fallbackCredentialIds: agent.fallbackCredentialIds || [],
    apiEndpoint: agent.apiEndpoint || null,
    claudeSessionId: null,
    messages: [],
    createdAt: now,
    lastActiveAt: now,
    active: false,
    sessionType: 'human' as const,
    agentId,
    plugins: agent.plugins || agent.tools || [],
    heartbeatEnabled: agent.heartbeatEnabled || false,
    heartbeatIntervalSec: agent.heartbeatIntervalSec || null,
  }

  sessions[sessionId] = session as Record<string, unknown>
  saveSessions(sessions)

  agent.threadSessionId = sessionId
  agent.updatedAt = Date.now()
  saveAgents(agents)

  return NextResponse.json(session)
}
