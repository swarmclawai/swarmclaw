import { NextResponse } from 'next/server'
import { probeOpenClawHealth } from '@/lib/server/openclaw/health'

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
  const { searchParams } = new URL(req.url)
  const endpoint = searchParams.get('endpoint')
  const credentialId = searchParams.get('credentialId')
  const token = searchParams.get('token')
  const model = searchParams.get('model')
  const timeoutMs = parseIntBounded(searchParams.get('timeoutMs'), 8000, 1000, 30000)
  const result = await probeOpenClawHealth({ endpoint, credentialId, token, model, timeoutMs })
  return NextResponse.json(result)
}
