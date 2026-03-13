import { NextResponse } from 'next/server'
import { getPluginManager } from '@/lib/server/plugins'
import { notify } from '@/lib/server/ws-hub'
import '@/lib/server/builtin-plugins'

export const dynamic = 'force-dynamic'

export async function GET() {
  const manager = getPluginManager()
  return NextResponse.json(manager.listPlugins().filter((plugin) => !plugin.isBuiltin))
}

export async function POST(req: Request) {
  const body = await req.json()
  const { filename, enabled } = body

  if (!filename || typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'filename and enabled required' }, { status: 400 })
  }

  const manager = getPluginManager()
  const plugin = manager.listPlugins().find((entry) => entry.filename === filename)
  if (!plugin || plugin.isBuiltin) {
    return NextResponse.json({ error: 'Only external extensions can be toggled from this surface' }, { status: 400 })
  }
  manager.setEnabled(filename, enabled)
  notify('extensions')

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
    return NextResponse.json({ error: 'Cannot delete built-in or non-existent extension' }, { status: 400 })
  }
  notify('extensions')
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: Request) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  const all = searchParams.get('all') === 'true'

  const manager = getPluginManager()

  if (all) {
    await manager.updateAllPlugins()
    notify('extensions')
    return NextResponse.json({ ok: true, message: 'All extensions updated' })
  }

  if (id) {
    await manager.updatePlugin(id)
    notify('extensions')
    return NextResponse.json({ ok: true, message: `Extension ${id} updated` })
  }

  return NextResponse.json({ error: 'id or all=true required' }, { status: 400 })
}
