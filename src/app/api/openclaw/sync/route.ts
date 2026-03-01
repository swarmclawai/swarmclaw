import { NextResponse } from 'next/server'
import { runSync, type SyncType } from '@/lib/server/openclaw-sync'
export const dynamic = 'force-dynamic'

const VALID_ACTIONS = new Set(['push', 'pull', 'both'])
const VALID_TYPES: SyncType[] = ['memory', 'workspace', 'schedules', 'credentials', 'plugins']

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const action = body.action
    const types = body.types

    if (!action || !VALID_ACTIONS.has(action)) {
      return NextResponse.json({ error: 'Invalid action. Use push, pull, or both.' }, { status: 400 })
    }
    if (!Array.isArray(types) || types.length === 0) {
      return NextResponse.json({ error: 'types must be a non-empty array.' }, { status: 400 })
    }
    const validTypes = types.filter((t: string) => VALID_TYPES.includes(t as SyncType)) as SyncType[]
    if (validTypes.length === 0) {
      return NextResponse.json({ error: `No valid types. Use: ${VALID_TYPES.join(', ')}` }, { status: 400 })
    }

    const results = await runSync({ action, types: validTypes })
    return NextResponse.json({ ok: true, results })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Sync failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
