import { NextResponse } from 'next/server'
import { loadUsage, loadSessions } from '@/lib/server/storage'
import type { UsageRecord } from '@/types'

export const dynamic = 'force-dynamic'

type SessionSnapshot = {
  id?: string
  agentId?: string
  createdAt?: number
  lastActiveAt?: number
  messages?: unknown[]
}

interface LiveUsage {
  sessionId: string
  records: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  firstAt: number | null
  lastAt: number | null
  wallclockMs: number
  turns: number
}

function summarize(sessionId: string, records: UsageRecord[], session: SessionSnapshot | undefined): LiveUsage {
  let totalTokens = 0
  let inputTokens = 0
  let outputTokens = 0
  let estimatedCost = 0
  let firstAt: number | null = null
  let lastAt: number | null = null

  for (const r of records) {
    totalTokens += r.totalTokens || 0
    inputTokens += r.inputTokens || 0
    outputTokens += r.outputTokens || 0
    estimatedCost += r.estimatedCost || 0
    const ts = r.timestamp || 0
    if (ts > 0) {
      if (firstAt === null || ts < firstAt) firstAt = ts
      if (lastAt === null || ts > lastAt) lastAt = ts
    }
  }

  const turns = Array.isArray(session?.messages) ? session!.messages!.length : records.length
  const wallStart = session?.createdAt ?? firstAt ?? 0
  const wallEnd = session?.lastActiveAt ?? lastAt ?? Date.now()
  const wallclockMs = wallStart > 0 ? Math.max(0, wallEnd - wallStart) : 0

  return {
    sessionId,
    records: records.length,
    totalTokens,
    inputTokens,
    outputTokens,
    estimatedCost: Math.round(estimatedCost * 10000) / 10000,
    firstAt,
    lastAt,
    wallclockMs,
    turns,
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const sessionId = searchParams.get('sessionId')?.trim()

  const usage = loadUsage() as Record<string, UsageRecord[]>
  const sessions = loadSessions() as Record<string, SessionSnapshot>

  if (sessionId) {
    const records = usage[sessionId] ?? []
    const session = sessions[sessionId]
    return NextResponse.json(summarize(sessionId, records, session))
  }

  // Without sessionId, return the 10 most recently active sessions
  const ids = Object.keys(usage)
  const recent = ids
    .map((id) => {
      const records = usage[id] ?? []
      const last = records.reduce((m, r) => Math.max(m, r.timestamp || 0), 0)
      return { id, last }
    })
    .sort((a, b) => b.last - a.last)
    .slice(0, 10)

  return NextResponse.json(
    recent.map(({ id }) => summarize(id, usage[id] ?? [], sessions[id])),
  )
}
