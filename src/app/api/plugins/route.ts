import { NextResponse } from 'next/server'
import { getPluginManager } from '@/lib/server/plugins'
export const dynamic = 'force-dynamic'


export async function GET(_req: Request) {
  const manager = getPluginManager()
  return NextResponse.json(manager.listPlugins())
}

export async function POST(req: Request) {
  const body = await req.json()
  const { filename, enabled } = body

  if (!filename || typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'filename and enabled required' }, { status: 400 })
  }

  const manager = getPluginManager()
  manager.setEnabled(filename, enabled)

  return NextResponse.json({ ok: true })
}
