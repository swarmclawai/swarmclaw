import { NextResponse } from 'next/server'
import { inferPluginPublisherSourceFromUrl } from '@/lib/plugin-sources'
import { searchClawHub } from '@/lib/server/skills/clawhub-client'
import type { PluginCatalogSource } from '@/types'
import { errorMessage } from '@/lib/shared-utils'

export const dynamic = 'force-dynamic'

interface RegistryPluginEntry {
  id?: string
  name?: string
  description?: string
  url?: string
  author?: string
  version?: string
  tags?: string[]
  openclaw?: boolean
  downloads?: number
}

const REGISTRY_URLS: Array<{ url: string; catalogSource: PluginCatalogSource }> = [
  { url: 'https://swarmclaw.ai/registry/plugins.json', catalogSource: 'swarmclaw-site' },
  { url: 'https://raw.githubusercontent.com/swarmclawai/swarmforge/main/registry.json', catalogSource: 'swarmforge' },
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
  const registryPlugins = new Map<string, Record<string, unknown>>()

  // 1. Fetch SwarmClaw Registry
  for (const registry of REGISTRY_URLS) {
    try {
      const res = await fetch(registry.url, { cache: 'no-store' })
      if (!res.ok) continue

      const data = await res.json()
      const entries = Array.isArray(data) ? data as RegistryPluginEntry[] : []
      const filtered = entries.filter((p) => {
        if (!p || typeof p.name !== 'string' || typeof p.description !== 'string') return false
        return !query || p.name.toLowerCase().includes(query.toLowerCase()) || p.description.toLowerCase().includes(query.toLowerCase())
      })

      for (const p of filtered) {
        const normalizedUrl = normalizeRegistryPluginUrl(p.url) || p.url
        const id = p.id || (p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '_')
        if (registryPlugins.has(id)) continue
        registryPlugins.set(id, {
          ...p,
          id,
          url: normalizedUrl,
          source: inferPluginPublisherSourceFromUrl(normalizedUrl) || 'swarmforge',
          catalogSource: registry.catalogSource,
        })
      }
    } catch (err: unknown) {
      console.warn('[marketplace] SC Registry failed:', {
        registryUrl: registry.url,
        error: errorMessage(err),
      })
    }
  }

  allPlugins.push(...registryPlugins.values())

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
      source: 'clawhub',
      catalogSource: 'clawhub',
    })))
  } catch (err: unknown) {
    console.warn('[marketplace] ClawHub failed:', errorMessage(err))
  }

  allPlugins.sort((a, b) => {
    const catalogA = typeof a.catalogSource === 'string' ? a.catalogSource : ''
    const catalogB = typeof b.catalogSource === 'string' ? b.catalogSource : ''
    if (catalogA !== catalogB) return catalogA.localeCompare(catalogB)
    const nameA = typeof a.name === 'string' ? a.name : ''
    const nameB = typeof b.name === 'string' ? b.name : ''
    return nameA.localeCompare(nameB)
  })

  // Update cache only for empty queries
  if (!query) {
    cache = { data: allPlugins, fetchedAt: now }
  }

  return NextResponse.json(allPlugins)
}
