import { NextResponse } from 'next/server'
import { ensureDaemonStarted, getDaemonStatus, runDaemonHealthCheckNow } from '@/lib/server/runtime/daemon-state'

export async function POST() {
  ensureDaemonStarted('api/daemon/health-check:post')
  await runDaemonHealthCheckNow()
  return NextResponse.json({
    ok: true,
    status: getDaemonStatus(),
  })
}
