import { NextResponse } from 'next/server'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import { loadSessions, saveSessions, deleteSession, active, loadAgents } from '@/lib/server/storage'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { notify } from '@/lib/server/ws-hub'
import { getSessionRunState } from '@/lib/server/session-run-manager'
import { normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'
export const dynamic = 'force-dynamic'


export async function GET(_req: Request) {
  const sessions = loadSessions()
  for (const id of Object.keys(sessions)) {
    const run = getSessionRunState(id)
    sessions[id].active = active.has(id) || !!run.runningRunId
    sessions[id].queuedCount = run.queueLength
    sessions[id].currentRunId = run.runningRunId || null
  }
  return NextResponse.json(sessions)
}

export async function DELETE(req: Request) {
  const { ids } = await req.json() as { ids: string[] }
  if (!Array.isArray(ids) || !ids.length) {
    return new NextResponse('Missing ids', { status: 400 })
  }
  const sessions = loadSessions()
  for (const id of ids) {
    if (sessions[id]?.name === '__main__') continue
    if (active.has(id)) {
      try { active.get(id).kill() } catch {}
      active.delete(id)
    }
    deleteSession(id)
  }
  notify('sessions')
  return NextResponse.json({ deleted: ids.length })
}

export async function POST(req: Request) {
  const body = await req.json()
  let cwd = (body.cwd || '').trim()
  if (cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(2))
  else if (cwd === '~') cwd = os.homedir()
  else if (!cwd) cwd = WORKSPACE_DIR

  const id = body.id || crypto.randomBytes(4).toString('hex')
  const sessions = loadSessions()
  const agent = body.agentId ? loadAgents()[body.agentId] : null
  const requestedTools = Array.isArray(body.tools) ? body.tools : null
  const resolvedTools = requestedTools ?? (Array.isArray(agent?.tools) ? agent.tools : [])

  // If session with this ID already exists, return it as-is
  if (body.id && sessions[id]) {
    return NextResponse.json(sessions[id])
  }

  const sessionName = body.name || 'New Session'

  sessions[id] = {
    id, name: sessionName, cwd,
    user: body.user || 'wayde',
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
    tools: resolvedTools,
    heartbeatEnabled: body.heartbeatEnabled ?? null,
    heartbeatIntervalSec: body.heartbeatIntervalSec ?? null,
  }
  saveSessions(sessions)
  notify('sessions')
  return NextResponse.json(sessions[id])
}
