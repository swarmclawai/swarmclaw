import { NextResponse } from 'next/server'
import { getPluginManager } from '@/lib/server/plugins'
import '@/lib/server/builtin-plugins'

export const dynamic = 'force-dynamic'

/** GET /api/plugins/settings?pluginId=X — read per-plugin settings */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const pluginId = searchParams.get('pluginId')
  if (!pluginId) {
    return NextResponse.json({ error: 'pluginId required' }, { status: 400 })
  }

  return NextResponse.json(getPluginManager().getPublicPluginSettings(pluginId))
}

/** PUT /api/plugins/settings?pluginId=X — write per-plugin settings */
export async function PUT(req: Request) {
  const { searchParams } = new URL(req.url)
  const pluginId = searchParams.get('pluginId')
  if (!pluginId) {
    return NextResponse.json({ error: 'pluginId required' }, { status: 400 })
  }

  try {
    const body = await req.json() as Record<string, unknown>
    const saved = getPluginManager().setPluginSettings(pluginId, body)
    return NextResponse.json({
      ok: true,
      values: saved,
      configuredSecretFields: getPluginManager().getPublicPluginSettings(pluginId).configuredSecretFields,
    })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    )
  }
}
