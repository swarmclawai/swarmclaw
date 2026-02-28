import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { loadMcpServers, saveMcpServers } from '@/lib/server/storage'

export async function GET() {
  return NextResponse.json(loadMcpServers())
}

export async function POST(req: Request) {
  const body = await req.json()
  const servers = loadMcpServers()
  const id = crypto.randomBytes(4).toString('hex')
  servers[id] = {
    id,
    name: body.name,
    transport: body.transport,
    command: body.command,
    args: body.args,
    url: body.url,
    env: body.env,
    headers: body.headers,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  saveMcpServers(servers)
  return NextResponse.json(servers[id])
}
