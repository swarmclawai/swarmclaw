import { NextResponse } from 'next/server'
import { DEFAULT_HEARTBEAT_INTERVAL_SEC } from '@/lib/heartbeat-defaults'
import { disableAllSessionHeartbeats, loadSettings, saveSettings } from '@/lib/server/storage'
import { cancelAllHeartbeatRuns } from '@/lib/server/session-run-manager'

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const action = typeof body?.action === 'string' ? body.action : 'disable_all'
  if (action !== 'disable_all') {
    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 })
  }

  const updatedSessions = disableAllSessionHeartbeats()
  const settings = loadSettings()
  if ((settings.heartbeatIntervalSec ?? DEFAULT_HEARTBEAT_INTERVAL_SEC) !== 0) {
    settings.heartbeatIntervalSec = 0
    saveSettings(settings)
  }
  const { cancelledQueued, abortedRunning } = cancelAllHeartbeatRuns('Heartbeat disabled via global switch')

  return NextResponse.json({
    ok: true,
    updatedSessions,
    cancelledQueued,
    abortedRunning,
  })
}
