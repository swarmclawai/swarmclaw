import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import os from 'os'
import path from 'path'
import { loadSessions, saveSessions, deleteSession, active, loadAgents } from '@/lib/server/storage'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { notify } from '@/lib/server/ws-hub'
import { getSessionRunState } from '@/lib/server/session-run-manager'
import { normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'
export const dynamic = 'force-dynamic'


export async function GET(req: Request) {
  const sessions = loadSessions()
  for (const id of Object.keys(sessions)) {
    const run = getSessionRunState(id)
    sessions[id].active = active.has(id) || !!run.runningRunId
    sessions[id].queuedCount = run.queueLength
    sessions[id].currentRunId = run.runningRunId || null
  }

  const { searchParams } = new URL(req.url)
  const limitParam = searchParams.get('limit')
  if (!limitParam) return NextResponse.json(sessions)

  const limit = Math.max(1, Number(limitParam) || 50)
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0)
  const all = Object.values(sessions).sort((a, b) => (b.lastActiveAt ?? b.createdAt) - (a.lastActiveAt ?? a.createdAt))
  const items = all.slice(offset, offset + limit)
  return NextResponse.json({ items, total: all.length, hasMore: offset + limit < all.length })
}

export async function DELETE(req: Request) {
  const { ids } = await req.json().catch(() => ({ ids: [] })) as { ids: string[] }
  if (!Array.isArray(ids) || !ids.length) {
    return new NextResponse('Missing ids', { status: 400 })
  }
  const sessions = loadSessions()
  let deleted = 0
  for (const id of ids) {
    if (!sessions[id]) continue
    if (active.has(id)) {
      try { active.get(id).kill() } catch {}
      active.delete(id)
    }
    deleteSession(id)
    deleted += 1
  }
  notify('sessions')
  return NextResponse.json({ deleted, requested: ids.length })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  let cwd = (body.cwd || '').trim()
  if (cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(2))
  else if (cwd === '~') cwd = os.homedir()
  else if (!cwd) cwd = WORKSPACE_DIR

  const id = body.id || genId()
  const sessions = loadSessions()
  const agent = body.agentId ? loadAgents()[body.agentId] : null
  const requestedPlugins = Array.isArray(body.plugins) ? body.plugins : (Array.isArray(body.tools) ? body.tools : null)
  const resolvedPlugins = requestedPlugins ?? (Array.isArray(agent?.plugins) ? agent.plugins : (Array.isArray(agent?.tools) ? agent.tools : []))

  // If session with this ID already exists, return it as-is
  if (body.id && sessions[id]) {
    return NextResponse.json(sessions[id])
  }

  const sessionName = body.name || 'New Chat'

  sessions[id] = {
    id, name: sessionName, cwd,
    user: body.user || 'user',
    provider: body.provider || agent?.provider || 'claude-cli',
    model: body.model || agent?.model || '',
    credentialId: body.credentialId || agent?.credentialId || null,
    apiEndpoint: normalizeProviderEndpoint(
      body.provider || agent?.provider || 'claude-cli',
      body.apiEndpoint || agent?.apiEndpoint || null,
    ),
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    delegateResumeIds: {
      claudeCode: null,
      codex: null,
      opencode: null,
    },
    messages: Array.isArray(body.messages) ? body.messages : [],
    createdAt: Date.now(), lastActiveAt: Date.now(),
    sessionType: body.sessionType || 'human',
    agentId: body.agentId || null,
    parentSessionId: body.parentSessionId || null,
    plugins: resolvedPlugins,
    heartbeatEnabled: body.heartbeatEnabled ?? null,
    heartbeatIntervalSec: body.heartbeatIntervalSec ?? null,
  }
  saveSessions(sessions)
  notify('sessions')
  return NextResponse.json(sessions[id])
}
