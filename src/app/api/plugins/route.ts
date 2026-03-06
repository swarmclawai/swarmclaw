import { NextResponse } from 'next/server'
import { getPluginManager } from '@/lib/server/plugins'
import { notify } from '@/lib/server/ws-hub'
import '@/lib/server/builtin-plugins'

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
  notify('plugins')

  return NextResponse.json({ ok: true })
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url)
  const filename = searchParams.get('filename')
  if (!filename) {
    return NextResponse.json({ error: 'filename required' }, { status: 400 })
  }
  const manager = getPluginManager()
  const deleted = manager.deletePlugin(filename)
  if (!deleted) {
    return NextResponse.json({ error: 'Cannot delete built-in or non-existent plugin' }, { status: 400 })
  }
  notify('plugins')
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: Request) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  const all = searchParams.get('all') === 'true'
  
  const manager = getPluginManager()
  
  if (all) {
    await manager.updateAllPlugins()
    notify('plugins')
    return NextResponse.json({ ok: true, message: 'All plugins updated' })
  }
  
  if (id) {
    await manager.updatePlugin(id)
    notify('plugins')
    return NextResponse.json({ ok: true, message: `Plugin ${id} updated` })
  }
  
  return NextResponse.json({ error: 'id or all=true required' }, { status: 400 })
}
