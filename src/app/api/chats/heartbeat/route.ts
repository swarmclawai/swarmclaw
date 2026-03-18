import { NextResponse } from 'next/server'
import { DEFAULT_HEARTBEAT_INTERVAL_SEC } from '@/lib/runtime/heartbeat-defaults'
import { cancelAllHeartbeatRuns } from '@/lib/server/runtime/session-run-manager'
import { disableAllSessionHeartbeats } from '@/lib/server/sessions/session-repository'
import { loadSettings, saveSettings } from '@/lib/server/settings/settings-repository'

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
