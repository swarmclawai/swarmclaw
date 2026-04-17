import { NextResponse } from 'next/server'
import { loadMcpServers } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { connectMcpServer, disconnectMcpServer } from '@/lib/server/mcp-client'

// Tokenizer-free estimate — same formula as @swarmclawai/mcp-gateway's
// tokens.ts so the two numbers line up when users compare side-by-side.
const CHARS_PER_TOKEN = 3.5

function estimateToolTokens(tool: {
  name: string
  description?: string
  inputSchema?: unknown
}): number {
  const json = JSON.stringify({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? {},
  })
  return Math.ceil(json.length / CHARS_PER_TOKEN)
}

/**
 * Discovery + token-cost endpoint for an MCP server. Connects, lists tools,
 * estimates per-tool schema tokens, and returns aggregate totals — including
 * how many tokens would actually be bound given the server's current
 * alwaysExpose policy. The MCP servers UI uses this to render the token-cost
 * badge on each card and the per-tool checklist in the allow-list editor.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const servers = loadMcpServers()
  const config = servers[id]
  if (!config) return notFound()

  let client: Awaited<ReturnType<typeof connectMcpServer>>['client'] | null = null
  let transport: Awaited<ReturnType<typeof connectMcpServer>>['transport'] | null = null
  try {
    const conn = await connectMcpServer(config)
    client = conn.client
    transport = conn.transport
    const { tools } = await client.listTools()
    const detailed = tools.map((t: { name: string; description?: string; inputSchema?: unknown }) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? {},
      tokens: estimateToolTokens(t),
    }))
    const totalTokens = detailed.reduce((n: number, t: { tokens: number }) => n + t.tokens, 0)
    const mode = config.alwaysExpose === undefined ? true : config.alwaysExpose
    const exposedTokens =
      mode === true
        ? totalTokens
        : mode === false
          ? 0
          : detailed
              .filter((t: { name: string }) => (mode as string[]).includes(t.name))
              .reduce((n: number, t: { tokens: number }) => n + t.tokens, 0)
    return NextResponse.json({
      tools: detailed,
      totalTokens,
      exposedTokens,
      alwaysExpose: mode,
    })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'MCP connection failed' },
      { status: 502 },
    )
  } finally {
    if (client && transport) {
      await disconnectMcpServer(client, transport)
    }
  }
}
