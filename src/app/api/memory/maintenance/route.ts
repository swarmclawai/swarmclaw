import { NextResponse } from 'next/server'
import { getMemoryDb } from '@/lib/server/memory-db'
import { loadSettings } from '@/lib/server/storage'

function parseBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === '1' || v === 'yes') return true
    if (v === 'false' || v === '0' || v === 'no') return false
  }
  return fallback
}

function parseIntBounded(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export async function GET(req: Request) {
  const db = getMemoryDb()
  const settings = loadSettings()
  const { searchParams } = new URL(req.url)
  const ttlHours = parseIntBounded(
    searchParams.get('ttlHours') ?? settings.memoryWorkingTtlHours,
    24,
    1,
    24 * 365,
  )
  const analyzed = db.analyzeMaintenance(ttlHours)
  return NextResponse.json({
    ok: true,
    ttlHours,
    analyzed,
  })
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const settings = loadSettings()
  const db = getMemoryDb()
  const ttlHours = parseIntBounded(body?.ttlHours ?? settings.memoryWorkingTtlHours, 24, 1, 24 * 365)
  const maxDeletes = parseIntBounded(body?.maxDeletes, 500, 1, 20_000)
  const result = db.maintain({
    ttlHours,
    maxDeletes,
    dedupe: parseBool(body?.dedupe, true),
    canonicalDedupe: parseBool(body?.canonicalDedupe, false),
    pruneWorking: parseBool(body?.pruneWorking, true),
  })
  return NextResponse.json({
    ok: true,
    ttlHours,
    maxDeletes,
    ...result,
  })
}

