import type { ClawHubSkill } from '@/types'
import { errorMessage } from '@/lib/shared-utils'

export interface ClawHubSearchResult {
  skills: ClawHubSkill[]
  total: number
  page: number
  nextCursor?: string | null
  error?: string
}

export interface ClawHubBundleFile {
  path: string
  content: Buffer
}

export interface ClawHubSkillBundle {
  slug: string
  content: string
  files: ClawHubBundleFile[]
}

const CLAWHUB_BASE_URL = process.env.CLAWHUB_API_URL || 'https://clawhub.ai/api/v1'
const CLAWHUB_DOWNLOAD_API_URL = process.env.CLAWHUB_DOWNLOAD_API_URL || 'https://wry-manatee-359.convex.site/api/v1'

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
  const listingUrl = `https://clawhub.ai/skills/${raw.slug}`
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
    stars: raw.stats?.stars ?? undefined,
    url: listingUrl,
    version,
    changelog: raw.latestVersion?.changelog,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    metadata: raw.metadata
      ? (raw.url ? { ...raw.metadata, upstreamUrl: raw.url } : raw.metadata)
      : raw.url ? { upstreamUrl: raw.url } : null,
  }
}

function extractClawHubSlug(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl)
    const parts = parsed.pathname.split('/').filter(Boolean)

    if (parsed.hostname === 'wry-manatee-359.convex.site') {
      const slug = parsed.searchParams.get('slug')
      return slug?.trim() || null
    }

    if (!parsed.hostname.endsWith('clawhub.ai')) return null
    if (parts[0] === 'skills' && parts[1]) return parts[1]
    if (parts.length >= 2) return parts[1]
    return null
  } catch {
    return null
  }
}

async function extractClawHubBundleFromZip(params: {
  slug: string
  buffer: ArrayBuffer
}): Promise<ClawHubSkillBundle> {
  const JSZip = (await import('jszip')).default
  const archive = await JSZip.loadAsync(Buffer.from(params.buffer))
  const preferredPatterns = [
    /^SKILL\.md$/i,
    /^README\.md$/i,
  ]
  const files = await Promise.all(
    Object.values(archive.files)
      .filter((file) => !file.dir)
      .map(async (file) => ({
        path: file.name,
        content: await file.async('nodebuffer'),
      })),
  )

  for (const pattern of preferredPatterns) {
    const match = Object.values(archive.files).find((file) => !file.dir && pattern.test(file.name))
    if (match) {
      return {
        slug: params.slug,
        content: await match.async('text'),
        files,
      }
    }
  }

  for (const pattern of preferredPatterns) {
    const match = Object.values(archive.files).find((file) => !file.dir && pattern.test(file.name.split('/').pop() || ''))
    if (match) {
      return {
        slug: params.slug,
        content: await match.async('text'),
        files,
      }
    }
  }

  throw new Error('Failed to fetch skill content: archive did not contain SKILL.md or README.md')
}

export async function fetchClawHubSkillBundle(rawUrl: string): Promise<ClawHubSkillBundle | null> {
  const slug = extractClawHubSlug(rawUrl)
  if (!slug) return null

  const downloadUrl = `${CLAWHUB_DOWNLOAD_API_URL}/download?slug=${encodeURIComponent(slug)}`
  const downloadResponse = await fetch(downloadUrl, { signal: AbortSignal.timeout(12000) })
  if (!downloadResponse.ok) {
    throw new Error(`Failed to fetch skill content: ${downloadResponse.status}`)
  }

  return extractClawHubBundleFromZip({
    slug,
    buffer: await downloadResponse.arrayBuffer(),
  })
}

export async function searchClawHub(query: string, page = 1, limit = 20, cursor?: string | null): Promise<ClawHubSearchResult> {
  try {
    const params = new URLSearchParams({ limit: String(limit) })
    if (query) params.set('q', query)
    if (cursor) {
      params.set('cursor', cursor)
    } else if (page > 1) {
      params.set('page', String(page))
    }

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
    const error = errorMessage(err)
    console.warn('[clawhub] search failed:', error)
    return { skills: [], total: 0, page, error }
  }
}

export async function fetchSkillContent(rawUrl: string): Promise<string> {
  const bundle = await fetchClawHubSkillBundle(rawUrl)
  if (bundle) {
    if (bundle.content.trim()) return bundle.content
    throw new Error('Failed to fetch skill content: archive did not contain readable skill content')
  }

  const res = await fetch(rawUrl, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`Failed to fetch skill content: ${res.status}`)
  return res.text()
}
