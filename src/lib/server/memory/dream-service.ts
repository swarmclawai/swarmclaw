import crypto from 'crypto'
import { z } from 'zod'
import type { DreamCycle, DreamCycleResult, DreamConfig, DreamTrigger, Agent } from '@/types'
import { DEFAULT_DREAM_CONFIG } from '@/types/dream'
import { getMemoryDb } from '@/lib/server/memory/memory-db'
import { saveDreamCycle } from '@/lib/server/memory/dream-cycles'
import { errorMessage } from '@/lib/shared-utils'
import { log } from '@/lib/server/logger'
import { resolveDreamGenerationPreference } from '@/lib/server/memory/dream-generation-preference'

const TAG = 'dream-service'

const EXEMPT_CATEGORIES = new Set(['daily_digest', 'consolidated_insight', 'dream_reflection'])

export function resolveDreamConfig(agent: Agent): DreamConfig {
  return { ...DEFAULT_DREAM_CONFIG, ...agent.dreamConfig }
}

export async function runTier1Dream(
  agentId: string,
  config: DreamConfig,
): Promise<Partial<DreamCycleResult>> {
  const memDb = getMemoryDb()
  const memories = memDb.getByAgent(agentId, 500)
  const now = Date.now()
  const decayAgeMs = config.decayAgeDays * 86_400_000
  const pruneMs = config.pruneThresholdDays * 86_400_000

  let decayed = 0
  let pruned = 0
  let promoted = 0
  const errors: string[] = []

  for (const mem of memories) {
    // Skip exempt categories
    if (EXEMPT_CATEGORIES.has(mem.category)) continue

    const tier = (mem.metadata as Record<string, unknown> | undefined)?.tier
    // Skip archived entries
    if (tier === 'archive') continue

    const age = now - (mem.createdAt || mem.updatedAt || 0)

    // Decay & Prune: old entries with no engagement
    if (age > decayAgeMs && (mem.accessCount || 0) === 0 && (mem.reinforcementCount || 0) === 0) {
      if (tier === 'working' && age > pruneMs) {
        memDb.delete(mem.id)
        pruned++
      } else {
        memDb.update(mem.id, {
          metadata: { ...(mem.metadata as Record<string, unknown>), decayedInDream: true },
        })
        decayed++
      }
      continue
    }

    // Promote: working-tier entries with high engagement
    if (
      (tier === 'working' || tier === '' || tier === undefined) &&
      (mem.accessCount || 0) >= 3 &&
      (mem.reinforcementCount || 0) >= 2
    ) {
      memDb.update(mem.id, {
        metadata: { ...(mem.metadata as Record<string, unknown>), tier: 'durable' },
      })
      promoted++
    }
  }

  // Dedup via maintain
  let deduped = 0
  try {
    const maintenance = memDb.maintain({ dedupe: true, pruneWorking: false })
    deduped = maintenance.deduped
  } catch (err: unknown) {
    const msg = `Dedup maintenance failed: ${errorMessage(err)}`
    log.warn(TAG, msg)
    errors.push(msg)
  }

  return { decayed, pruned, promoted, deduped, errors }
}

interface Tier2Consolidation {
  sourceIds: string[]
  title: string
  content: string
}

interface Tier2Reflection {
  title: string
  content: string
}

interface Tier2Flagged {
  memoryId: string
  reason: string
}

interface Tier2Response {
  consolidations?: Tier2Consolidation[]
  reflections?: Tier2Reflection[]
  flagged?: Tier2Flagged[]
}

const Tier2ResponseSchema = z.object({
  consolidations: z.array(z.object({
    sourceIds: z.array(z.string()),
    title: z.string(),
    content: z.string(),
  })).optional(),
  reflections: z.array(z.object({
    title: z.string(),
    content: z.string(),
  })).optional(),
  flagged: z.array(z.object({
    memoryId: z.string(),
    reason: z.string(),
  })).optional(),
}).passthrough()

function findBalancedJsonObjectEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    if (depth === 0) return index + 1
  }
  return -1
}

function extractFirstBalancedJsonObject(text: string): string | null {
  const source = String(text || '')
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '{') continue
    const end = findBalancedJsonObjectEnd(source, index)
    if (end === -1) return null
    return source.slice(index, end)
  }
  return null
}

export function parseTier2DreamResponseText(text: string): Tier2Response | null {
  const jsonText = extractFirstBalancedJsonObject(text)
  if (!jsonText) return null
  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  } catch {
    return null
  }
  const parsed = Tier2ResponseSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export async function runTier2Dream(
  agentId: string,
  config: DreamConfig,
): Promise<Partial<DreamCycleResult>> {
  const memDb = getMemoryDb()
  const allMemories = memDb.getByAgent(agentId, config.tier2MaxMemories)

  // Filter to durable tier and non-exempt entries
  const candidates = allMemories.filter((m) => {
    if (EXEMPT_CATEGORIES.has(m.category)) return false
    const tier = (m.metadata as Record<string, unknown> | undefined)?.tier
    return tier === 'durable' || tier === 'working' || tier === '' || tier === undefined
  })

  if (candidates.length < 3) {
    return { consolidated: 0, reflections: [], memoriesReviewed: 0, errors: [] }
  }

  const memoryLines = candidates.map((m) => {
    const content = (m.content || '').slice(0, 300)
    return `[${m.id}] [${m.category}] ${m.title}: ${content}`
  })

  const prompt = `You are reviewing your memories during a dream cycle to consolidate and reflect.

Review the following memories and respond with a JSON object:
{
  "consolidations": [{ "sourceIds": ["id1", "id2"], "title": "...", "content": "..." }],
  "reflections": [{ "title": "...", "content": "..." }],
  "flagged": [{ "memoryId": "...", "reason": "..." }]
}

Rules:
- Consolidate 2-5 groups of overlapping memories into single entries
- Write 1-3 high-level reflections about patterns you notice
- Flag any outdated or contradictory memories
- Be concise. Each consolidation and reflection should be 1-3 sentences.

MEMORIES:
${memoryLines.join('\n')}`

  const errors: string[] = []
  let consolidated = 0
  const reflectionTitles: string[] = []

  try {
    const { buildLLM } = await import('@/lib/server/build-llm')
    const { loadSettings } = await import('@/lib/server/settings/settings-repository')
    // `config` is the resolved per-agent dream config (defaults + overrides);
    // pass it so a per-agent provider/model takes precedence over global settings.
    const preferred = resolveDreamGenerationPreference(loadSettings(), config)
    const { llm } = await buildLLM({ agentId, preferred, responseFormat: 'json_object' })
    const { HumanMessage } = await import('@langchain/core/messages')

    const response = await llm.invoke([new HumanMessage(prompt)])
    const text = typeof response.content === 'string'
      ? response.content
      : Array.isArray(response.content)
        ? response.content.map((b) => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('')
        : ''

    const parsed = parseTier2DreamResponseText(text) ?? {}
    if (!parsed.consolidations && !parsed.reflections && !parsed.flagged) {
      errors.push('Tier 2 dream response was not valid structured JSON.')
    }

    // Process consolidations
    if (Array.isArray(parsed.consolidations)) {
      for (const c of parsed.consolidations) {
        if (!c.title || !c.content || !Array.isArray(c.sourceIds)) continue
        const validSourceIds = c.sourceIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        memDb.add({
          agentId,
          sessionId: null,
          category: 'consolidated_insight',
          title: c.title,
          content: c.content,
          linkedMemoryIds: validSourceIds,
          metadata: { tier: 'durable', origin: 'dream' },
        })
        consolidated++
      }
    }

    // Process reflections
    if (Array.isArray(parsed.reflections)) {
      for (const r of parsed.reflections) {
        if (!r.title || !r.content) continue
        memDb.add({
          agentId,
          sessionId: null,
          category: 'dream_reflection',
          title: r.title,
          content: r.content,
          metadata: { tier: 'durable', origin: 'dream' },
        })
        reflectionTitles.push(r.title)
      }
    }

    // Process flagged
    if (Array.isArray(parsed.flagged)) {
      for (const f of parsed.flagged) {
        if (!f.memoryId || !f.reason) continue
        const existing = memDb.get(f.memoryId)
        if (existing) {
          memDb.update(f.memoryId, {
            metadata: {
              ...(existing.metadata as Record<string, unknown>),
              flaggedInDream: true,
              flagReason: f.reason,
            },
          })
        }
      }
    }
  } catch (err: unknown) {
    errors.push(errorMessage(err))
  }

  return {
    consolidated,
    reflections: reflectionTitles,
    memoriesReviewed: candidates.length,
    errors,
  }
}

export async function executeDreamCycle(
  agentId: string,
  trigger: DreamTrigger,
): Promise<DreamCycle> {
  const { loadAgents, patchAgent, logActivity } = await import('@/lib/server/storage')
  const agents = loadAgents()
  const agent = agents[agentId]
  if (!agent) throw new Error(`Agent ${agentId} not found`)

  const config = resolveDreamConfig(agent)

  // Check cooldown
  if (agent.lastDreamAt && Date.now() - agent.lastDreamAt < config.cooldownMinutes * 60_000) {
    throw new Error('Dream on cooldown')
  }

  const cycle: DreamCycle = {
    id: crypto.randomUUID(),
    agentId,
    status: 'running',
    trigger,
    startedAt: Date.now(),
  }
  saveDreamCycle(cycle)

  try {
    // Tier 1: deterministic server-side operations
    const tier1 = await runTier1Dream(agentId, config)

    // Tier 2: LLM-driven reflection (optional)
    let tier2: Partial<DreamCycleResult> = {}
    if (config.tier2Enabled) {
      tier2 = await runTier2Dream(agentId, config)
    }

    const result: DreamCycleResult = {
      decayed: tier1.decayed ?? 0,
      pruned: tier1.pruned ?? 0,
      promoted: tier1.promoted ?? 0,
      deduped: tier1.deduped ?? 0,
      consolidated: tier2.consolidated ?? 0,
      reflections: tier2.reflections ?? [],
      memoriesReviewed: tier2.memoriesReviewed ?? 0,
      durationMs: Date.now() - cycle.startedAt,
      errors: [...(tier1.errors ?? []), ...(tier2.errors ?? [])],
    }

    cycle.status = 'completed'
    cycle.completedAt = Date.now()
    cycle.result = result
    saveDreamCycle(cycle)

    // Update agent
    patchAgent(agentId, (current) => {
      if (!current) return null
      return {
        ...current,
        lastDreamAt: Date.now(),
        dreamCycleCount: (current.dreamCycleCount || 0) + 1,
      }
    })

    logActivity({
      entityType: 'agent',
      entityId: agentId,
      action: 'dream_completed',
      actor: 'system',
      summary: `Dream cycle completed: ${result.decayed} decayed, ${result.pruned} pruned, ${result.consolidated} consolidated`,
    })

    log.info(TAG, `Dream cycle completed for agent ${agentId}`, {
      trigger,
      decayed: result.decayed,
      pruned: result.pruned,
      promoted: result.promoted,
      consolidated: result.consolidated,
    })

    return cycle
  } catch (err: unknown) {
    cycle.status = 'failed'
    cycle.completedAt = Date.now()
    cycle.error = errorMessage(err)
    saveDreamCycle(cycle)
    log.error(TAG, `Dream cycle failed for agent ${agentId}: ${errorMessage(err)}`)
    throw err
  }
}
