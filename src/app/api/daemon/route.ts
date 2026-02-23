import { NextResponse } from 'next/server'
import { ensureDaemonStarted, getDaemonStatus, startDaemon, stopDaemon } from '@/lib/server/daemon-state'

export async function GET() {
  ensureDaemonStarted('api/daemon:get')
  return NextResponse.json(getDaemonStatus())
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const action = body.action

  if (action === 'start') {
    startDaemon({ source: 'api/daemon:post:start', manualStart: true })
    return NextResponse.json({ ok: true, status: 'running' })
  } else if (action === 'stop') {
    stopDaemon({ source: 'api/daemon:post:stop', manualStop: true })
    return NextResponse.json({ ok: true, status: 'stopped' })
  }

  return NextResponse.json({ error: 'Invalid action. Use "start" or "stop".' }, { status: 400 })
}
