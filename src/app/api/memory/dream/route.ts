import { NextResponse } from 'next/server'
import { log } from '@/lib/server/logger'

const TAG = 'api-dream'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const agentId = searchParams.get('agentId') ?? undefined
    const limit = Math.max(1, Math.min(500, Number(searchParams.get('limit')) || 50))
    const { listDreamCycles } = await import('@/lib/server/memory/dream-cycles')
    const cycles = listDreamCycles(agentId, limit)
    return NextResponse.json({ ok: true, cycles })
  } catch (err: unknown) {
    log.error(TAG, 'GET failed:', err)
    return NextResponse.json({ ok: false, error: String((err as Error)?.message || err) }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const agentId = typeof body.agentId === 'string' ? body.agentId : undefined
    if (!agentId) {
      return NextResponse.json({ ok: false, error: 'agentId is required' }, { status: 400 })
    }
    const { executeDreamCycle } = await import('@/lib/server/memory/dream-service')
    const cycle = await executeDreamCycle(agentId, 'manual')
    return NextResponse.json({ ok: true, cycle })
  } catch (err: unknown) {
    log.error(TAG, 'POST failed:', err)
    return NextResponse.json({ ok: false, error: String((err as Error)?.message || err) }, { status: 500 })
  }
}
