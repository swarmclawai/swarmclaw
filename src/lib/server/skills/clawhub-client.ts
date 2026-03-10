import type { ClawHubSkill } from '@/types'
import { errorMessage } from '@/lib/shared-utils'

export interface ClawHubSearchResult {
  skills: ClawHubSkill[]
  total: number
  page: number
  nextCursor?: string | null
}

const CLAWHUB_BASE_URL = process.env.CLAWHUB_API_URL || 'https://clawhub.ai/api/v1'

/**
 * Raw shape returned by the ClawHub `/skills` endpoint.
 * Fields are mapped to our internal `ClawHubSkill` type.
 */
interface ClawHubRawItem {
  slug: string
  displayName?: string
  name?: string
  summary?: string
  description?: string
  author?: string | { name?: string }
  tags?: Record<string, string> | string[]
  stats?: { downloads?: number; installsAllTime?: number; stars?: number }
  latestVersion?: { version?: string; changelog?: string }
  metadata?: Record<string, unknown> | null
  url?: string
  createdAt?: number
  updatedAt?: number
}

function mapRawToSkill(raw: ClawHubRawItem): ClawHubSkill {
  const name = raw.displayName || raw.name || raw.slug
  const description = raw.summary || raw.description || ''
  const author = typeof raw.author === 'string'
    ? raw.author
    : raw.author?.name || 'community'
  const tags = Array.isArray(raw.tags)
    ? raw.tags
    : raw.tags ? Object.keys(raw.tags) : []
  const downloads = raw.stats?.installsAllTime ?? raw.stats?.downloads ?? 0
  const version = raw.latestVersion?.version || '1.0.0'
  return {
    id: raw.slug,
    name,
    description,
    author,
    tags,
    downloads,
    url: raw.url || `https://clawhub.ai/skills/${raw.slug}`,
    version,
  }
}

export async function searchClawHub(query: string, page = 1, limit = 20): Promise<ClawHubSearchResult> {
  try {
    const params = new URLSearchParams({ limit: String(limit) })
    if (query) params.set('q', query)
    if (page > 1) params.set('page', String(page))

    const url = `${CLAWHUB_BASE_URL}/skills?${params}`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`ClawHub responded with ${res.status}`)

    const data = await res.json() as { items?: ClawHubRawItem[]; skills?: ClawHubRawItem[]; nextCursor?: string | null; total?: number }

    // ClawHub v1 returns { items, nextCursor }; fall back to { skills, total } for compat
    const rawItems = data.items || data.skills || []
    const skills = rawItems.map(mapRawToSkill)
    const total = data.total ?? (data.nextCursor ? skills.length + 1 : skills.length)

    return { skills, total, page, nextCursor: data.nextCursor }
  } catch (err: unknown) {
    console.warn('[clawhub] search failed:', errorMessage(err))
    return { skills: [], total: 0, page }
  }
}

export async function fetchSkillContent(rawUrl: string): Promise<string> {
  // ClawHub skill pages are at /skills/<slug> — try raw content endpoint first
  let contentUrl = rawUrl
  if (contentUrl.startsWith('https://clawhub.ai/skills/') && !contentUrl.includes('/raw')) {
    const slug = contentUrl.replace('https://clawhub.ai/skills/', '').replace(/\/$/, '')
    // Try the raw content API first
    const rawApiUrl = `${CLAWHUB_BASE_URL}/skills/${slug}/content`
    try {
      const res = await fetch(rawApiUrl, { signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        const data = await res.json() as { content?: string }
        if (data.content) return data.content
      }
    } catch {
      // Fall through to direct fetch
    }
    // Try the raw endpoint pattern
    contentUrl = `https://clawhub.ai/skills/${slug}/raw`
  }

  const res = await fetch(contentUrl, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`Failed to fetch skill content: ${res.status}`)
  return res.text()
}
