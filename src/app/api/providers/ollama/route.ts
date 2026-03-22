import { NextResponse } from 'next/server'

/** Fetch locally installed models from Ollama API */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const endpoint = searchParams.get('endpoint') || 'http://localhost:11434'

  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      return NextResponse.json({ models: [], error: `Ollama returned ${res.status}` })
    }
    const data = await res.json()
    const models = (data.models || []).map((m: Record<string, unknown>) => ({
      name: typeof m.name === 'string' ? m.name.replace(/:latest$/, '') : m.name,
      size: m.size,
      modified: m.modified_at,
    }))
    return NextResponse.json({ models })
  } catch (err: unknown) {
    const e = err as Record<string, unknown>
    return NextResponse.json({
      models: [],
      error: e.code === 'ECONNREFUSED'
        ? 'Ollama is not running'
        : (err instanceof Error ? err.message : 'Failed to connect'),
    })
  }
}
