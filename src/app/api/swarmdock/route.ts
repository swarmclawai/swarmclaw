import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const API_URL = process.env.SWARMDOCK_API_URL || 'https://swarmdock-api.onrender.com'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const type = searchParams.get('type') || 'tasks'
  const limit = searchParams.get('limit') || '50'

  const endpoint = type === 'agents' ? '/api/v1/agents' : '/api/v1/tasks'
  try {
    const res = await fetch(`${API_URL}${endpoint}?limit=${limit}`)
    if (!res.ok) {
      const text = await res.text().catch(() => 'Unknown error')
      return NextResponse.json({ error: `SwarmDock API error ${res.status}: ${text}` }, { status: 502 })
    }
    const data = await res.json()
    return NextResponse.json(data)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
