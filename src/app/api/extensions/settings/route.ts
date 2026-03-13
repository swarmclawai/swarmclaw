import { NextResponse } from 'next/server'
import { getPluginManager } from '@/lib/server/plugins'
import '@/lib/server/builtin-plugins'
import { errorMessage } from '@/lib/shared-utils'

export const dynamic = 'force-dynamic'

function resolveExternalExtension(pluginId: string) {
  const plugin = getPluginManager().listPlugins().find((entry) => entry.filename === pluginId)
  if (!plugin || plugin.isBuiltin) return null
  return plugin
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const pluginId = searchParams.get('pluginId')
  if (!pluginId) {
    return NextResponse.json({ error: 'pluginId required' }, { status: 400 })
  }
  if (!resolveExternalExtension(pluginId)) {
    return NextResponse.json({ error: 'Only external extensions expose settings here' }, { status: 400 })
  }

  return NextResponse.json(getPluginManager().getPublicPluginSettings(pluginId))
}

export async function PUT(req: Request) {
  const { searchParams } = new URL(req.url)
  const pluginId = searchParams.get('pluginId')
  if (!pluginId) {
    return NextResponse.json({ error: 'pluginId required' }, { status: 400 })
  }
  if (!resolveExternalExtension(pluginId)) {
    return NextResponse.json({ error: 'Only external extensions expose settings here' }, { status: 400 })
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
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 })
  }
}
