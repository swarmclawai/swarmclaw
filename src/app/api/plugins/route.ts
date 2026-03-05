import { NextResponse } from 'next/server'
import { getPluginManager } from '@/lib/server/plugins'
import { notify } from '@/lib/server/ws-hub'

// Ensure all builtin plugins are registered by importing their modules
import '@/lib/server/session-tools/shell'
import '@/lib/server/session-tools/file'
import '@/lib/server/session-tools/edit_file'
import '@/lib/server/session-tools/web'
import '@/lib/server/session-tools/memory'
import '@/lib/server/session-tools/platform'
import '@/lib/server/session-tools/monitor'
import '@/lib/server/session-tools/discovery'
import '@/lib/server/session-tools/sample-ui'
import '@/lib/server/session-tools/git'
import '@/lib/server/session-tools/wallet'
import '@/lib/server/session-tools/connector'
import '@/lib/server/session-tools/http'
import '@/lib/server/session-tools/sandbox'
import '@/lib/server/session-tools/canvas'
import '@/lib/server/session-tools/chatroom'
import '@/lib/server/session-tools/delegate'
import '@/lib/server/session-tools/schedule'
import '@/lib/server/session-tools/session-info'
import '@/lib/server/session-tools/openclaw-nodes'
import '@/lib/server/session-tools/openclaw-workspace'
import '@/lib/server/session-tools/context-mgmt'
import '@/lib/server/session-tools/subagent'
import '@/lib/server/session-tools/plugin-creator'

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
    return NextResponse.json({ ok: true, message: 'All plugins updated' })
  }
  
  if (id) {
    await manager.updatePlugin(id)
    return NextResponse.json({ ok: true, message: `Plugin ${id} updated` })
  }
  
  return NextResponse.json({ error: 'id or all=true required' }, { status: 400 })
}
