import { NextResponse } from 'next/server'
import { detectConfigIssues, repairConfigIssue } from '@/lib/server/openclaw-config-sync'

/** GET — detect configuration issues */
export async function GET() {
  try {
    const issues = await detectConfigIssues()
    return NextResponse.json({ issues })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

/** POST { issueId } — repair a specific issue */
export async function POST(req: Request) {
  const body = await req.json()
  const { issueId } = body as { issueId?: string }
  if (!issueId) {
    return NextResponse.json({ error: 'Missing issueId' }, { status: 400 })
  }

  try {
    const result = await repairConfigIssue(issueId)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 })
    }
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
