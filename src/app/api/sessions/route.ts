import { NextResponse } from 'next/server'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import { loadSessions, saveSessions, active } from '@/lib/server/storage'
import { getSessionRunState } from '@/lib/server/session-run-manager'

export async function GET() {
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
    delete sessions[id]
  }
  saveSessions(sessions)
  return NextResponse.json({ deleted: ids.length })
}

export async function POST(req: Request) {
  const body = await req.json()
  let cwd = (body.cwd || '').trim()
  if (cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(2))
  else if (cwd === '~' || !cwd) cwd = os.homedir()

  const id = body.id || crypto.randomBytes(4).toString('hex')
  const sessions = loadSessions()
  // If session with this ID already exists, return it as-is
  if (body.id && sessions[id]) {
    return NextResponse.json(sessions[id])
  }
  sessions[id] = {
    id, name: body.name || 'New Session', cwd,
    user: body.user || 'wayde',
    provider: body.provider || 'claude-cli',
    model: body.model || '',
    credentialId: body.credentialId || null,
    apiEndpoint: body.apiEndpoint || null,
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    delegateResumeIds: {
      claudeCode: null,
      codex: null,
      opencode: null,
    },
    messages: [],
    createdAt: Date.now(), lastActiveAt: Date.now(),
    sessionType: body.sessionType || 'human',
    agentId: body.agentId || null,
    parentSessionId: body.parentSessionId || null,
    tools: body.tools || [],
    heartbeatEnabled: body.heartbeatEnabled ?? null,
    heartbeatIntervalSec: body.heartbeatIntervalSec ?? null,
  }
  saveSessions(sessions)
  return NextResponse.json(sessions[id])
}
