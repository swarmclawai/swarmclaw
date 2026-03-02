import { getMemoryDb } from './memory-db'
import { HumanMessage } from '@langchain/core/messages'

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
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const digestTitle = `Daily digest: ${today}`
  const cutoff24h = Date.now() - 24 * 3600_000
  const errors: string[] = []
  let digestsCreated = 0

  for (const agentKey of Object.keys(counts)) {
    if (agentKey === '_global') continue
    const agentId = agentKey

    try {
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

      // Use the configured LangGraph (utility) provider
      const { buildLLM } = await import('./build-llm')
      const { llm } = await buildLLM()

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
      errors.push(`Agent ${agentId}: ${err instanceof Error ? err.message : String(err)}`)
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
