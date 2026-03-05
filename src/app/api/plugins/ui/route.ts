import { NextResponse } from 'next/server'
import { getPluginManager } from '@/lib/server/plugins'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type') // 'sidebar', 'header', etc.
  
  const manager = getPluginManager()
  const extensions = manager.getUIExtensions()
  
  if (type === 'sidebar') {
    const items = extensions.flatMap(ui => ui.sidebarItems || [])
    return NextResponse.json(items)
  }
  
  if (type === 'header') {
    const widgets = extensions.flatMap(ui => ui.headerWidgets || [])
    return NextResponse.json(widgets)
  }
  
  if (type === 'chat_actions') {
    const actions = extensions.flatMap(ui => ui.chatInputActions || [])
    return NextResponse.json(actions)
  }
  
  if (type === 'connectors') {
    const connectors = manager.getConnectors()
    return NextResponse.json(connectors)
  }

  return NextResponse.json(extensions)
}
