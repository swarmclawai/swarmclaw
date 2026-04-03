import { NextResponse } from 'next/server'
import { log } from '@/lib/server/logger'

const TAG = 'api-dream'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { getDreamCycle } = await import('@/lib/server/memory/dream-cycles')
    const cycle = getDreamCycle(id)
    if (!cycle) {
      return NextResponse.json({ ok: false, error: 'Dream cycle not found' }, { status: 404 })
    }
    return NextResponse.json({ ok: true, cycle })
  } catch (err: unknown) {
    log.error(TAG, 'GET [id] failed:', err)
    return NextResponse.json({ ok: false, error: String((err as Error)?.message || err) }, { status: 500 })
  }
}
