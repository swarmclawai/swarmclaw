import { NextResponse } from 'next/server'
import { loadMcpServers } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { connectMcpServer, disconnectMcpServer } from '@/lib/server/mcp-client'

function parseArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Handled by caller via fallback validation error.
    }
  }
  return {}
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const servers = loadMcpServers()
  const server = servers[id]
  if (!server) return notFound()

  const body = await req.json().catch(() => null)
  const toolName = typeof body?.toolName === 'string' ? body.toolName.trim() : ''
  if (!toolName) {
    return NextResponse.json({ error: 'toolName is required' }, { status: 400 })
  }

  const argsRaw = body?.args
  if (
    argsRaw !== undefined
    && typeof argsRaw !== 'string'
    && (typeof argsRaw !== 'object' || Array.isArray(argsRaw))
  ) {
    return NextResponse.json({ error: 'args must be an object or JSON string' }, { status: 400 })
  }
  const args = parseArgs(argsRaw)

  let client: unknown
  let transport: unknown
  try {
    const conn = await connectMcpServer(server)
    client = conn.client
    transport = conn.transport
    const result = await (client as { callTool: (opts: { name: string; arguments: Record<string, unknown> }) => Promise<Record<string, unknown>> }).callTool({
      name: toolName,
      arguments: args,
    })
    const textParts = Array.isArray(result?.content)
      ? (result.content as Array<Record<string, unknown>>)
          .filter((part) => part?.type === 'text' && typeof part?.text === 'string')
          .map((part) => part.text as string)
      : []
    const text = textParts.join('\n').trim() || '(no text output)'

    return NextResponse.json({
      ok: true,
      toolName,
      args,
      text,
      result,
      isError: result?.isError === true,
    })
  } catch (err: unknown) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'MCP tool invocation failed' },
      { status: 500 },
    )
  } finally {
    if (client && transport) {
      await disconnectMcpServer(client, transport)
    }
  }
}

