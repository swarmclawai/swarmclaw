import { NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { listRunningConnectors, getRunningInstance } = await import('@/lib/server/connectors/manager')
    const openclawConnectors = listRunningConnectors('openclaw')

    if (!openclawConnectors.length) {
      return NextResponse.json({ devices: [], note: 'No running OpenClaw connector.' })
    }

    // The directory.list RPC requires gateway support — degrade gracefully
    return NextResponse.json({
      devices: [],
      connectors: openclawConnectors.map((c) => ({
        id: c.id,
        name: c.name,
        platform: c.platform,
      })),
      note: 'Directory listing requires OpenClaw gateway directory.list RPC support.',
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Directory listing failed' }, { status: 500 })
  }
}
