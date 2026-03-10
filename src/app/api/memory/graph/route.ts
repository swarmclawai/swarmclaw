import { NextResponse } from 'next/server'
import { getMemoryDb } from '@/lib/server/memory/memory-db'
import type { MemoryEntry } from '@/types'

export const dynamic = 'force-dynamic'

/** GET /api/memory/graph — returns a node-link structure of the memory graph */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const agentId = searchParams.get('agentId')
  const limit = Math.min(1000, Math.max(1, Number(searchParams.get('limit')) || 200))
  
  const db = getMemoryDb()
  const entries: MemoryEntry[] = db.list(agentId || undefined, limit)
  
  const nodes = entries.map(e => ({
    id: e.id,
    title: e.title,
    category: e.category,
    agentId: e.agentId,
    contentPreview: e.content.slice(0, 100) + (e.content.length > 100 ? '...' : ''),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    pinned: e.pinned
  }))

  const links: Array<{ source: string; target: string; type: string }> = []
  const entryIds = new Set(entries.map(e => e.id))

  for (const entry of entries) {
    if (entry.linkedMemoryIds && Array.isArray(entry.linkedMemoryIds)) {
      for (const targetId of entry.linkedMemoryIds) {
        // Only include links where both nodes are in the current set (or could fetch more if needed)
        if (entryIds.has(targetId)) {
          links.push({
            source: entry.id,
            target: targetId,
            type: 'linked'
          })
        }
      }
    }
  }

  return NextResponse.json({ nodes, links })
}
