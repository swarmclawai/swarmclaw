import { NextResponse } from 'next/server'
import {
  loadTasks,
  loadAgents,
  loadSessions,
  loadSchedules,
  loadWebhooks,
  loadSkills,
} from '@/lib/server/storage'

interface SearchResult {
  type: 'task' | 'agent' | 'session' | 'schedule' | 'webhook' | 'skill'
  id: string
  title: string
  description?: string
  status?: string
}

const MAX_RESULTS = 20

function matches(haystack: string | undefined | null, needle: string): boolean {
  if (!haystack) return false
  return haystack.toLowerCase().includes(needle)
}

function searchCollection(
  collection: Record<string, Record<string, unknown>>,
  type: SearchResult['type'],
  needle: string,
  titleKey: string,
  descKey: string,
  statusKey?: string,
): SearchResult[] {
  const results: SearchResult[] = []
  for (const [id, item] of Object.entries(collection)) {
    const title = item[titleKey] as string | undefined
    const desc = item[descKey] as string | undefined
    const idStr = typeof item.id === 'string' ? item.id : id
    if (matches(title, needle) || matches(desc, needle) || matches(idStr, needle)) {
      results.push({
        type,
        id,
        title: title || idStr || id,
        description: desc ? desc.slice(0, 120) : undefined,
        status: statusKey ? (item[statusKey] as string | undefined) : undefined,
      })
    }
  }
  return results
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') || '').trim().toLowerCase()

  if (q.length < 2) {
    return NextResponse.json({ results: [] })
  }

  const tasks = loadTasks() as Record<string, Record<string, unknown>>
  const agents = loadAgents() as Record<string, Record<string, unknown>>
  const sessions = loadSessions() as Record<string, Record<string, unknown>>
  const schedules = loadSchedules() as Record<string, Record<string, unknown>>
  const webhooks = loadWebhooks() as Record<string, Record<string, unknown>>
  const skills = loadSkills() as Record<string, Record<string, unknown>>

  const buckets: SearchResult[][] = [
    searchCollection(agents, 'agent', q, 'name', 'description'),
    searchCollection(tasks, 'task', q, 'title', 'description', 'status'),
    searchCollection(sessions, 'session', q, 'name', 'cwd'),
    searchCollection(schedules, 'schedule', q, 'name', 'taskPrompt', 'status'),
    searchCollection(webhooks, 'webhook', q, 'name', 'source'),
    searchCollection(skills, 'skill', q, 'name', 'description'),
  ]

  // Proportional allocation across types
  const totalRaw = buckets.reduce((s, b) => s + b.length, 0)
  if (totalRaw === 0) {
    return NextResponse.json({ results: [] })
  }

  const results: SearchResult[] = []
  if (totalRaw <= MAX_RESULTS) {
    for (const bucket of buckets) results.push(...bucket)
  } else {
    // Give each bucket a fair share, round-robin leftover slots
    const perBucket = Math.floor(MAX_RESULTS / buckets.length)
    let remaining = MAX_RESULTS
    for (const bucket of buckets) {
      const take = Math.min(bucket.length, perBucket)
      results.push(...bucket.slice(0, take))
      remaining -= take
    }
    // Fill remaining slots from buckets that had more
    for (const bucket of buckets) {
      if (remaining <= 0) break
      const alreadyTaken = Math.min(bucket.length, perBucket)
      const extra = bucket.slice(alreadyTaken, alreadyTaken + remaining)
      results.push(...extra)
      remaining -= extra.length
    }
  }

  return NextResponse.json({ results })
}
