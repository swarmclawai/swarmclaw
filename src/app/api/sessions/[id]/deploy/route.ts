import { NextResponse } from 'next/server'
import { execSync } from 'child_process'
import { loadSessions } from '@/lib/server/storage'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessions = loadSessions()
  const session = sessions[id]
  if (!session) return new NextResponse(null, { status: 404 })

  const body = await req.json()
  const msg = body.message || 'Deploy from SwarmClaw'

  try {
    const opts = { cwd: session.cwd, encoding: 'utf8' as const, timeout: 30000 }
    execSync('git add -A', opts)
    let committed = false
    try {
      execSync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, opts)
      committed = true
    } catch (ce: any) {
      if (!(ce.stdout || ce.stderr || '').includes('nothing to commit')) throw ce
    }
    execSync('git push 2>&1', opts)
    console.log(`[${id}] deployed: ${msg}`)
    return NextResponse.json({ ok: true, output: committed ? 'Committed and pushed!' : 'Already committed — pushed to remote!' })
  } catch (e: any) {
    console.error(`[${id}] deploy error:`, e.message)
    return NextResponse.json(
      { ok: false, error: (e.stderr || e.stdout || e.message).toString().slice(0, 300) },
      { status: 500 },
    )
  }
}
