import { NextResponse } from 'next/server'
import crypto from 'crypto'
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

  // If agent already has a thread session that exists, return it
  if (agent.threadSessionId && sessions[agent.threadSessionId]) {
    return NextResponse.json(sessions[agent.threadSessionId])
  }

  // Check if an existing session is already linked to this agent as a thread
  const existing = Object.values(sessions).find(
    (s: Record<string, unknown>) => s.name === `agent-thread:${agentId}` && s.user === user
  )
  if (existing) {
    agent.threadSessionId = (existing as Record<string, unknown>).id as string
    agent.updatedAt = Date.now()
    saveAgents(agents)
    return NextResponse.json(existing)
  }

  // Create a new thread session
  const sessionId = `agent-thread-${agentId}-${crypto.randomBytes(4).toString('hex')}`
  const now = Date.now()
  const session = {
    id: sessionId,
    name: `agent-thread:${agentId}`,
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
    tools: agent.tools || [],
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
