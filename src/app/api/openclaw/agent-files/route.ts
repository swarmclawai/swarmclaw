import { NextResponse } from 'next/server'
import { ensureGatewayConnected } from '@/lib/server/openclaw-gateway'

const AGENT_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'MEMORY.md', 'AGENTS.md'] as const

/** GET ?agentId=X — fetch all agent files from gateway */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const agentId = searchParams.get('agentId')
  if (!agentId) {
    return NextResponse.json({ error: 'Missing agentId' }, { status: 400 })
  }

  const gw = await ensureGatewayConnected()
  if (!gw) {
    return NextResponse.json({ error: 'OpenClaw gateway not connected' }, { status: 503 })
  }

  const files: Record<string, { content: string; error?: string }> = {}
  await Promise.all(
    AGENT_FILES.map(async (filename) => {
      try {
        const result = await gw.rpc('agents.files.get', { agentId, filename }) as { content?: string } | undefined
        files[filename] = { content: result?.content ?? '' }
      } catch (err: unknown) {
        files[filename] = { content: '', error: err instanceof Error ? err.message : String(err) }
      }
    }),
  )

  return NextResponse.json(files)
}

/** PUT { agentId, filename, content } — save an agent file */
export async function PUT(req: Request) {
  const body = await req.json()
  const { agentId, filename, content } = body as { agentId?: string; filename?: string; content?: string }
  if (!agentId || !filename) {
    return NextResponse.json({ error: 'Missing agentId or filename' }, { status: 400 })
  }
  if (!AGENT_FILES.includes(filename as typeof AGENT_FILES[number])) {
    return NextResponse.json({ error: `Invalid filename: ${filename}` }, { status: 400 })
  }

  const gw = await ensureGatewayConnected()
  if (!gw) {
    return NextResponse.json({ error: 'OpenClaw gateway not connected' }, { status: 503 })
  }

  try {
    await gw.rpc('agents.files.set', { agentId, filename, content: content ?? '' })
    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
