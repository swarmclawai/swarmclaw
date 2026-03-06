import { NextResponse } from 'next/server'
import { getPluginManager } from '@/lib/server/plugins'

export async function POST(req: Request) {
  const body = await req.json()
  const filename = typeof body?.filename === 'string' ? body.filename : ''
  const packageManager = typeof body?.packageManager === 'string' ? body.packageManager : undefined

  if (!filename) {
    return NextResponse.json({ error: 'filename is required' }, { status: 400 })
  }

  try {
    const result = await getPluginManager().installPluginDependencies(filename, {
      packageManager: packageManager as import('@/types').PluginPackageManager | undefined,
    })
    return NextResponse.json({ ok: true, dependencyInfo: result })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    )
  }
}
