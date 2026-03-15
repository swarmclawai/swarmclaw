import { getMemoryDb } from '@/lib/server/memory/memory-db'
import { loadAgents } from '@/lib/server/storage'
import { resolveGenerationModelConfig } from '@/lib/server/build-llm'
import { HumanMessage } from '@langchain/core/messages'
import { errorMessage } from '@/lib/shared-utils'
import { onNextIdleWindow } from '@/lib/server/runtime/idle-window'

let consolidationRegistered = false
let compactionRegistered = false

/**
 * Register daily consolidation to run during the next idle window.
 * The idle-window system guarantees execution within 24h even without idle time.
 */
export function registerConsolidationIdleCallback(): void {
  if (consolidationRegistered) return
  consolidationRegistered = true
  onNextIdleWindow(async () => {
    consolidationRegistered = false
    await runDailyConsolidation()
    registerConsolidationIdleCallback()
  })
}

/**
 * Register access-based compaction to run during the next idle window.
 */
export function registerCompactionIdleCallback(): void {
  if (compactionRegistered) return
  compactionRegistered = true
  onNextIdleWindow(async () => {
    compactionRegistered = false
    await runAccessBasedCompaction()
    registerCompactionIdleCallback()
  })
}

function canCreateDailyDigestForAgent(
  agentId: string,
  agents: ReturnType<typeof loadAgents>,
): boolean {
  const agent = agents[agentId]
  if (!agent || agent.trashedAt) return false
  try {
    resolveGenerationModelConfig({ agentId })
    return true
  } catch (err: unknown) {
    const message = errorMessage(err)
    if (message.includes('No generation-compatible model is configured')) return false
    throw err
  }
}

/**
 * Produce daily digests per agent and prune stale entries.
 * Only fires when an agent has >5 non-breadcrumb memories in the past 24h
 * and no digest for today already exists.
 */
export async function runDailyConsolidation(): Promise<{
  digests: number
  pruned: number
  deduped: number
  errors: string[]
}> {
  const memDb = getMemoryDb()
  const counts = memDb.countsByAgent()
  const agents = loadAgents({ includeTrashed: true })
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const digestTitle = `Daily digest: ${today}`
  const cutoff24h = Date.now() - 24 * 3600_000
  const errors: string[] = []
  let digestsCreated = 0

  for (const agentKey of Object.keys(counts)) {
    if (agentKey === '_global') continue
    const agentId = agentKey

    try {
      if (!canCreateDailyDigestForAgent(agentId, agents)) continue

      // Check if digest already exists for today
      const existing = memDb.search(digestTitle, agentId)
      if (existing.some((m) => m.category === 'daily_digest' && m.title === digestTitle)) continue

      // Fetch recent memories (exclude breadcrumbs and digests)
      const recent = memDb.getByAgent(agentId, 100)
      const candidates = recent.filter((m) => {
        if (m.category === 'breadcrumb' || m.category === 'daily_digest') return false
        return (m.createdAt || m.updatedAt || 0) >= cutoff24h
      })

      if (candidates.length < 5) continue

      // Sort by reinforcement count descending so most-reinforced memories are prioritized in digest
      candidates.sort((a, b) => (b.reinforcementCount || 0) - (a.reinforcementCount || 0))

      // Build summarization prompt
      const memoryLines = candidates.slice(0, 30).map((m) => {
        const rc = m.reinforcementCount || 0
        const content = (m.content || '').slice(0, 300)
        return `- [${m.category}]${rc > 0 ? ` (reinforced x${rc})` : ''} ${m.title}: ${content}`
      })

      const prompt = [
        'Summarize the following memory entries from the last 24 hours into a concise daily digest.',
        'Focus on key decisions, discoveries, and outcomes. Skip trivial or redundant entries.',
        'Format as 3-7 bullet points. Be concise.',
        '',
        ...memoryLines,
      ].join('\n')

      // Use the target agent's configured generation provider
      const { buildLLM } = await import('@/lib/server/build-llm')
      const { llm } = await buildLLM({ agentId })

      const response = await llm.invoke([new HumanMessage(prompt)])
      const digestContent = typeof response.content === 'string'
        ? response.content
        : Array.isArray(response.content)
          ? response.content.map((b) => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('')
          : ''

      if (!digestContent.trim()) continue

      const digestCandidates = candidates.slice(0, 30)
      const linkedMemoryIds = digestCandidates.slice(0, 10).map((m) => m.id)
      memDb.add({
        agentId,
        sessionId: null,
        category: 'daily_digest',
        title: digestTitle,
        content: digestContent.trim(),
        linkedMemoryIds,
      })

      // Reset reinforcement counts on entries folded into the digest to prevent double-counting
      for (const m of digestCandidates) {
        if (m.reinforcementCount && m.reinforcementCount > 0) {
          memDb.update(m.id, { reinforcementCount: 0 })
        }
      }

      digestsCreated++
    } catch (err: unknown) {
      errors.push(`Agent ${agentId}: ${errorMessage(err)}`)
    }
  }

  // Run maintenance: dedupe + prune stale working entries
  const maintenance = memDb.maintain({ dedupe: true, pruneWorking: true, ttlHours: 24 })

  return {
    digests: digestsCreated,
    pruned: maintenance.pruned,
    deduped: maintenance.deduped,
    errors,
  }
}

/**
 * Access-pattern-driven memory compaction:
 * 1. Promote working-tier entries with high access + reinforcement to durable
 * 2. Archive durable entries with zero access and age > 60 days
 * 3. Merge frequently co-accessed entries (same agent, 5+ accesses in 7d) into consolidated insights
 */
export async function runAccessBasedCompaction(): Promise<{
  promoted: number
  archived: number
  merged: number
  errors: string[]
}> {
  const memDb = getMemoryDb()
  const counts = memDb.countsByAgent()
  const errors: string[] = []
  let promoted = 0
  let archived = 0
  let merged = 0
  const now = Date.now()
  const sixtyDaysAgo = now - 60 * 86_400_000

  for (const agentKey of Object.keys(counts)) {
    if (agentKey === '_global') continue
    const agentId = agentKey

    try {
      const allEntries = memDb.getByAgent(agentId, 500)

      // 1. Promote working → durable
      for (const entry of allEntries) {
        const tier = typeof entry.metadata?.tier === 'string' ? entry.metadata.tier : ''
        if (tier !== 'working' && tier !== '') continue
        if ((entry.accessCount || 0) >= 3 && (entry.reinforcementCount || 0) >= 2) {
          memDb.update(entry.id, {
            metadata: { ...entry.metadata, tier: 'durable' },
          })
          promoted++
        }
      }

      // 2. Archive stale durable entries
      for (const entry of allEntries) {
        const tier = typeof entry.metadata?.tier === 'string' ? entry.metadata.tier : ''
        if (tier !== 'durable') continue
        if ((entry.accessCount || 0) === 0 && (entry.updatedAt || entry.createdAt) < sixtyDaysAgo) {
          memDb.update(entry.id, {
            metadata: { ...entry.metadata, tier: 'archive' },
          })
          archived++
        }
      }

      // 3. Merge frequently co-accessed entries into consolidated insights
      const frequent = memDb.getFrequentlyAccessedByAgent(agentId, 5, 7)
      if (frequent.length >= 2) {
        const contentLines = frequent.slice(0, 6).map((m) => {
          return `- [${m.category}] ${m.title}: ${(m.content || '').slice(0, 200)}`
        })
        const consolidatedContent = `Consolidated insight from ${frequent.length} frequently accessed memories:\n${contentLines.join('\n')}`
        const linkedIds = frequent.slice(0, 6).map((m) => m.id)

        memDb.add({
          agentId,
          sessionId: null,
          category: 'consolidated_insight',
          title: `Consolidated insight: ${new Date().toISOString().slice(0, 10)}`,
          content: consolidatedContent,
          linkedMemoryIds: linkedIds,
          metadata: { tier: 'durable', origin: 'access-compaction', autoWritten: true },
        })
        merged++
      }
    } catch (err: unknown) {
      errors.push(`Agent ${agentId}: ${errorMessage(err)}`)
    }
  }

  return { promoted, archived, merged, errors }
}
