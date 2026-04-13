import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { genId } from '@/lib/id'
import { loadMcpServers, saveMcpServers } from '@/lib/server/storage'
export const dynamic = 'force-dynamic'


export async function GET(_req: Request) {
  return NextResponse.json(loadMcpServers())
}

export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody(req)
  if (error) return error
  const servers = loadMcpServers()
  const id = genId()
  servers[id] = {
    id,
    name: body.name,
    transport: body.transport,
    command: body.command,
    args: body.args,
    cwd: body.cwd,
    url: body.url,
    env: body.env,
    headers: body.headers,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  saveMcpServers(servers)
  return NextResponse.json(servers[id])
}
