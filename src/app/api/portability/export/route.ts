import { NextResponse } from 'next/server'
import { buildPortableExportFilename, exportConfig } from '@/lib/server/portability/export'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const projectId = searchParams.get('projectId')?.trim() || null
  try {
    const manifest = exportConfig({ projectId })
    if (searchParams.get('download') === 'true') {
      return new NextResponse(JSON.stringify(manifest, null, 2), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${buildPortableExportFilename(manifest)}"`,
        },
      })
    }
    return NextResponse.json(manifest)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to export manifest'
    if (message.startsWith('Project not found: ')) {
      return NextResponse.json({ error: message }, { status: 404 })
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
