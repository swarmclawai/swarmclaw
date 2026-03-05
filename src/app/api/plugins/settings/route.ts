import { NextResponse } from 'next/server'
import { loadSettings, saveSettings } from '@/lib/server/storage'

export const dynamic = 'force-dynamic'

/** GET /api/plugins/settings?pluginId=X — read per-plugin settings */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const pluginId = searchParams.get('pluginId')
  if (!pluginId) {
    return NextResponse.json({ error: 'pluginId required' }, { status: 400 })
  }

  const settings = loadSettings()
  const pluginSettings = (settings.pluginSettings as Record<string, Record<string, unknown>> | undefined) ?? {}
  return NextResponse.json(pluginSettings[pluginId] ?? {})
}

/** PUT /api/plugins/settings?pluginId=X — write per-plugin settings */
export async function PUT(req: Request) {
  const { searchParams } = new URL(req.url)
  const pluginId = searchParams.get('pluginId')
  if (!pluginId) {
    return NextResponse.json({ error: 'pluginId required' }, { status: 400 })
  }

  const body = await req.json() as Record<string, unknown>
  const settings = loadSettings()
  const pluginSettings = (settings.pluginSettings as Record<string, Record<string, unknown>> | undefined) ?? {}
  pluginSettings[pluginId] = body
  settings.pluginSettings = pluginSettings
  saveSettings(settings)

  return NextResponse.json({ ok: true })
}
