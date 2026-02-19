import { NextResponse } from 'next/server'
import { getDaemonStatus, startDaemon, stopDaemon } from '@/lib/server/daemon-state'

export async function GET() {
  return NextResponse.json(getDaemonStatus())
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const action = body.action

  if (action === 'start') {
    startDaemon()
    return NextResponse.json({ ok: true, status: 'running' })
  } else if (action === 'stop') {
    stopDaemon()
    return NextResponse.json({ ok: true, status: 'stopped' })
  }

  return NextResponse.json({ error: 'Invalid action. Use "start" or "stop".' }, { status: 400 })
}
