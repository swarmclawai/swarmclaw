import { NextResponse } from 'next/server'
import { loadMcpServers } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { connectMcpServer, disconnectMcpServer } from '@/lib/server/mcp-client'

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
    return NextResponse.json(
      tools.map((t: { name: string; description?: string; inputSchema?: unknown }) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? {},
      }))
    )
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'MCP connection failed' }, { status: 502 })
  } finally {
    if (client && transport) {
      await disconnectMcpServer(client, transport)
    }
  }
}
