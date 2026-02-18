import { NextResponse } from 'next/server'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import { loadSessions, saveSessions, active } from '@/lib/server/storage'

export async function GET() {
  const sessions = loadSessions()
  for (const id of Object.keys(sessions)) {
    sessions[id].active = active.has(id)
  }
  return NextResponse.json(sessions)
}

export async function POST(req: Request) {
  const body = await req.json()
  let cwd = (body.cwd || '').trim()
  if (cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(2))
  else if (cwd === '~' || !cwd) cwd = os.homedir()

  const id = crypto.randomBytes(4).toString('hex')
  const sessions = loadSessions()
  sessions[id] = {
    id, name: body.name || 'New Session', cwd,
    user: body.user || 'wayde',
    provider: body.provider || 'claude-cli',
    model: body.model || '',
    credentialId: body.credentialId || null,
    apiEndpoint: body.apiEndpoint || null,
    claudeSessionId: null, messages: [],
    createdAt: Date.now(), lastActiveAt: Date.now(),
    sessionType: body.sessionType || 'human',
    agentId: body.agentId || null,
    parentSessionId: body.parentSessionId || null,
    tools: body.tools || [],
  }
  saveSessions(sessions)
  return NextResponse.json(sessions[id])
}
