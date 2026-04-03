import { NextResponse } from 'next/server'
import { execSync, execFileSync } from 'child_process'
import { notFound } from '@/lib/server/collection-helpers'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { log } from '@/lib/server/logger'
import { getSession } from '@/lib/server/sessions/session-repository'

const TAG = 'api-deploy'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = getSession(id)
  if (!session) return notFound()

  const { data: body, error } = await safeParseBody<{ message?: string }>(req)
  if (error) return error
  const msg = body.message || 'Deploy from SwarmClaw'

  try {
    const opts = { cwd: session.cwd, encoding: 'utf8' as const, timeout: 30000 }
    execSync('git add -A', opts)
    let committed = false
    try {
      execFileSync('git', ['commit', '-m', msg], opts)
      committed = true
    } catch (ce: unknown) {
      const ex = ce as { stdout?: string; stderr?: string }
      if (!(ex.stdout || ex.stderr || '').includes('nothing to commit')) throw ce
    }
    execSync('git push 2>&1', opts)
    log.info(TAG, `deployed: ${msg}`)
    return NextResponse.json({ ok: true, output: committed ? 'Committed and pushed!' : 'Already committed — pushed to remote!' })
  } catch (e: unknown) {
    const ex = e as { stderr?: string; stdout?: string; message?: string }
    log.error(TAG, `deploy error:`, ex.message)
    return NextResponse.json(
      { ok: false, error: (ex.stderr || ex.stdout || ex.message || 'Unknown error').toString().slice(0, 300) },
      { status: 500 },
    )
  }
}
