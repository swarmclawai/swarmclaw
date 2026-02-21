import { NextResponse } from 'next/server'
import { getDaemonStatus, runDaemonHealthCheckNow } from '@/lib/server/daemon-state'

export async function POST() {
  await runDaemonHealthCheckNow()
  return NextResponse.json({
    ok: true,
    status: getDaemonStatus(),
  })
}
