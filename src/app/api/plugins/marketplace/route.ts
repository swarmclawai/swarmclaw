import { NextResponse } from 'next/server'
import { searchClawHub } from '@/lib/server/clawhub-client'

export const dynamic = 'force-dynamic'

const REGISTRY_URLS = [
  'https://raw.githubusercontent.com/swarmclawai/swarmforge/main/registry.json',
  'https://swarmclaw.ai/registry/plugins.json',
]
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

let cache: { data: unknown; fetchedAt: number } | null = null

function normalizeRegistryPluginUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  if (!trimmed) return null
  return trimmed
    .replace('github.com/swarmclawai/plugins/', 'github.com/swarmclawai/swarmforge/')
    .replace('raw.githubusercontent.com/swarmclawai/plugins/', 'raw.githubusercontent.com/swarmclawai/swarmforge/')
    .replace('/swarmclawai/swarmforge/master/', '/swarmclawai/swarmforge/main/')
    .replace('/swarmclawai/plugins/master/', '/swarmclawai/swarmforge/main/')
    .replace('/swarmclawai/plugins/main/', '/swarmclawai/swarmforge/main/')
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const query = searchParams.get('q') || ''
  
  const now = Date.now()
  if (!query && cache && now - cache.fetchedAt < CACHE_TTL) {
    return NextResponse.json(cache.data)
  }

  const allPlugins: Record<string, unknown>[] = []

  // 1. Fetch SwarmClaw Registry
  for (const registryUrl of REGISTRY_URLS) {
    try {
      const res = await fetch(registryUrl, { cache: 'no-store' })
      if (!res.ok) continue

      const data = await res.json()
      const filtered = (data as Array<{ name: string; description: string; url?: string }>).filter((p) => {
        if (!p || typeof p.name !== 'string' || typeof p.description !== 'string') return false
        return !query || p.name.toLowerCase().includes(query.toLowerCase()) || p.description.toLowerCase().includes(query.toLowerCase())
      })

      allPlugins.push(...filtered.map((p: { id?: string; name?: string; url?: string }) => ({
        ...p,
        id: p.id || (p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '_'),
        url: normalizeRegistryPluginUrl(p.url) || p.url,
        source: 'swarmclaw',
      })))
      break
    } catch (err: unknown) {
      console.warn('[marketplace] SC Registry failed:', {
        registryUrl,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 2. Fetch ClawHub Skills/Plugins
  try {
    const hubResults = await searchClawHub(query)
    allPlugins.push(...hubResults.skills.map(s => ({
      id: s.id, // Explicitly ensure ID is present
      name: s.name,
      description: s.description,
      author: s.author,
      version: s.version || '1.0.0',
      url: s.url,
      source: 'clawhub'
    })))
  } catch (err: unknown) {
    console.warn('[marketplace] ClawHub failed:', err instanceof Error ? err.message : String(err))
  }

  // Update cache only for empty queries
  if (!query) {
    cache = { data: allPlugins, fetchedAt: now }
  }

  return NextResponse.json(allPlugins)
}
