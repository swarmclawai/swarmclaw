import { NextResponse } from 'next/server'
import { notify } from '@/lib/server/ws-hub'
export const dynamic = 'force-dynamic'


export async function GET() {
  const { getDaemonStatus } = await import('@/lib/server/runtime/daemon-state')
  return NextResponse.json(getDaemonStatus())
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const action = body.action

  if (action === 'start') {
    const { startDaemon } = await import('@/lib/server/runtime/daemon-state')
    startDaemon({ source: 'api/daemon:post:start', manualStart: true })
    notify('daemon')
    return NextResponse.json({ ok: true, status: 'running' })
  } else if (action === 'stop') {
    const { stopDaemon } = await import('@/lib/server/runtime/daemon-state')
    stopDaemon({ source: 'api/daemon:post:stop', manualStop: true })
    notify('daemon')
    return NextResponse.json({ ok: true, status: 'stopped' })
  }

  return NextResponse.json({ error: 'Invalid action. Use "start" or "stop".' }, { status: 400 })
}
