import type { ClawHubSkill } from '@/types'

export interface ClawHubSearchResult {
  skills: ClawHubSkill[]
  total: number
  page: number
}

const CLAWHUB_BASE_URL = process.env.CLAWHUB_API_URL || 'https://clawhub.openclaw.dev/api'

export async function searchClawHub(query: string, page = 1, limit = 20): Promise<ClawHubSearchResult> {
  try {
    const url = `${CLAWHUB_BASE_URL}/skills?q=${encodeURIComponent(query)}&page=${page}&limit=${limit}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`ClawHub responded with ${res.status}`)
    return await res.json()
  } catch {
    return { skills: [], total: 0, page }
  }
}

export async function fetchSkillContent(rawUrl: string): Promise<string> {
  const res = await fetch(rawUrl)
  if (!res.ok) throw new Error(`Failed to fetch skill content: ${res.status}`)
  return res.text()
}
