import { NextResponse } from 'next/server'
import { loadMcpServers } from '@/lib/server/storage'
import { connectMcpServer, disconnectMcpServer } from '@/lib/server/mcp-client'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const servers = loadMcpServers()
  const config = servers[id]
  if (!config) return new NextResponse(null, { status: 404 })

  let client: any
  let transport: any
  try {
    const conn = await connectMcpServer(config)
    client = conn.client
    transport = conn.transport
    const { tools } = await client.listTools()
    return NextResponse.json(
      tools.map((t: any) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? {},
      }))
    )
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 502 })
  } finally {
    if (client && transport) {
      await disconnectMcpServer(client, transport)
    }
  }
}
