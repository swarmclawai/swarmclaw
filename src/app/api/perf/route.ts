import { NextResponse } from 'next/server'
import { perf } from '@/lib/server/runtime/perf'

export const dynamic = 'force-dynamic'

/**
 * GET /api/perf — Returns recent perf entries and current state.
 * POST /api/perf — Enable/disable perf tracing or clear entries.
 *
 * Only active when SWARMCLAW_PERF=1 or after POST {action:'enable'}.
 * Workbench tests use this to activate tracing and collect results.
 */

export function GET() {
  return NextResponse.json({
    enabled: perf.isEnabled(),
    entries: perf.getRecentEntries(),
    count: perf.getRecentEntries().length,
  })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const action = body.action

  if (action === 'enable') {
    perf.setEnabled(true)
    perf.clearRecentEntries()
    return NextResponse.json({ enabled: true })
  }

  if (action === 'disable') {
    perf.setEnabled(false)
    return NextResponse.json({ enabled: false })
  }

  if (action === 'clear') {
    perf.clearRecentEntries()
    return NextResponse.json({ cleared: true, enabled: perf.isEnabled() })
  }

  return NextResponse.json({ error: 'Invalid action. Use "enable", "disable", or "clear".' }, { status: 400 })
}
