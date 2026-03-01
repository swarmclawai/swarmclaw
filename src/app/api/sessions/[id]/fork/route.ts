import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { loadSessions, saveSessions } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json() as { messageIndex: number }
  const sessions = loadSessions()
  const source = sessions[id]
  if (!source) return notFound()

  const { messageIndex } = body
  if (typeof messageIndex !== 'number' || messageIndex < 0 || messageIndex >= source.messages.length) {
    return NextResponse.json({ error: 'Invalid message index' }, { status: 400 })
  }

  const now = Date.now()
  const newId = randomUUID()
  const forked = {
    id: newId,
    name: `Fork of ${source.name}`,
    cwd: source.cwd,
    user: source.user,
    provider: source.provider,
    model: source.model,
    credentialId: source.credentialId ?? null,
    fallbackCredentialIds: source.fallbackCredentialIds,
    apiEndpoint: source.apiEndpoint ?? null,
    claudeSessionId: null,
    messages: source.messages.slice(0, messageIndex + 1),
    createdAt: now,
    lastActiveAt: now,
    agentId: source.agentId ?? null,
    parentSessionId: id,
    tools: source.tools,
    conversationTone: source.conversationTone,
  }

  sessions[newId] = forked
  saveSessions(sessions)

  return NextResponse.json(forked)
}
