import { NextResponse } from 'next/server'
import { loadMcpServers } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { runMcpConformanceCheck } from '@/lib/server/mcp-conformance'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const servers = loadMcpServers()
  const server = servers[id]
  if (!server) return notFound()

  const body = await req.json().catch(() => ({}))
  const timeoutMs = typeof body?.timeoutMs === 'number' ? body.timeoutMs : undefined
  const smokeToolName = typeof body?.smokeToolName === 'string' ? body.smokeToolName : undefined
  const smokeToolArgs = body?.smokeToolArgs && typeof body.smokeToolArgs === 'object' && !Array.isArray(body.smokeToolArgs)
    ? body.smokeToolArgs
    : undefined

  const result = await runMcpConformanceCheck(server, {
    timeoutMs,
    smokeToolName,
    smokeToolArgs,
  })

  return NextResponse.json(result, { status: result.ok ? 200 : 502 })
}
