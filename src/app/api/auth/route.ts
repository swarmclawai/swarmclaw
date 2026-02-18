import { NextResponse } from 'next/server'
import { validateAccessKey, getAccessKey, isFirstTimeSetup, markSetupComplete } from '@/lib/server/storage'

/** GET /api/auth — check if this is a first-time setup (returns key for initial display) */
export async function GET() {
  if (isFirstTimeSetup()) {
    return NextResponse.json({ firstTime: true, key: getAccessKey() })
  }
  return NextResponse.json({ firstTime: false })
}

/** POST /api/auth — validate an access key */
export async function POST(req: Request) {
  const { key } = await req.json()
  if (!key || !validateAccessKey(key)) {
    return NextResponse.json({ error: 'Invalid access key' }, { status: 401 })
  }
  // If this was first-time setup, mark it as claimed
  if (isFirstTimeSetup()) {
    markSetupComplete()
  }
  return NextResponse.json({ ok: true })
}
