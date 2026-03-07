import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import fs from 'fs'
import { genId } from '@/lib/id'
import {
  filterMemoriesByScope,
  getMemoryDb,
  getMemoryLookupLimits,
  normalizeMemoryScopeMode,
  storeMemoryImageAsset,
} from '../memory-db'
import { loadSettings } from '../storage'
import { expandQuery } from '../query-expansion'
import type { MemoryEntry, Plugin, PluginHooks } from '@/types'
import type { ToolBuildContext } from './context'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { partitionMemoriesByTier } from '../memory-tiers'
import { syncSessionArchiveMemory } from '../session-archive-memory'

/**
 * Advanced Database-Backed Memory logic.
 */
async function executeMemoryAction(input: any, ctx: any) {
  const normalized = normalizeToolInputArgs((input ?? {}) as Record<string, unknown>)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const n = normalized as Record<string, any>
  const {
    action, key, value, query, scope, rerank,
    scopeSessionId, projectRoot, filePaths, references, project,
    linkedMemoryIds, depth, linkedLimit, targetIds,
    tags, pinned, sharedWith
  } = n
  const category = typeof n.category === 'string' ? n.category : 'note'
  const imagePath = typeof n.imagePath === 'string' ? n.imagePath : undefined
  
  const memDb = getMemoryDb()
  const currentAgentId = ctx?.agentId || null
  const currentSessionId = typeof ctx?.sessionId === 'string'
    ? ctx.sessionId
    : typeof ctx?.id === 'string'
      ? ctx.id
      : null
  const currentSession = ctx && typeof ctx === 'object' && Array.isArray(ctx.messages) ? ctx : null
  const configuredScope = typeof ctx?.memoryScopeMode === 'string' ? ctx.memoryScopeMode : 'auto'
  const rawScope = typeof scope === 'string' ? scope : configuredScope
  const scopeMode = normalizeMemoryScopeMode(rawScope === 'shared' ? 'global' : rawScope)
  const rerankMode = rerank === 'semantic' || rerank === 'lexical' ? rerank : 'balanced'
  
  const scopeFilter = {
    mode: scopeMode,
    agentId: currentAgentId,
    sessionId: (typeof scopeSessionId === 'string' && scopeSessionId.trim()) ? scopeSessionId.trim() : currentSessionId,
    projectRoot: (typeof projectRoot === 'string' && projectRoot.trim())
      ? projectRoot.trim()
      : ((project && typeof project === 'object' && 'rootPath' in project && typeof (project as Record<string, unknown>).rootPath === 'string')
          ? (project as Record<string, unknown>).rootPath as string
          : (typeof ctx?.projectRoot === 'string' && ctx.projectRoot.trim() ? ctx.projectRoot.trim() : null)),
  }
  
  const filterScope = (rows: MemoryEntry[]) => filterMemoriesByScope(rows, scopeFilter)
  const canReadMemory = (m: MemoryEntry) => filterScope([m]).length > 0
  const canMutateMemory = (m: MemoryEntry) => !m?.agentId || m.agentId === currentAgentId

  const limits = getMemoryLookupLimits(loadSettings())
  const maxPerLookup = limits.maxPerLookup

  if ((action === 'search' || action === 'list') && currentSession) {
    try { syncSessionArchiveMemory(currentSession) } catch { /* archive sync is best-effort */ }
  }

  const formatEntry = (m: any) => {
    let line = `[${m.id}] (${m.agentId ? `agent:${m.agentId}` : 'shared'}) ${m.category}/${m.title}: ${m.content}`
    if (m.reinforcementCount) line += ` (reinforced ×${m.reinforcementCount})`
    if (m.references?.length) {
      line += `\n  refs: ${m.references.map((r: any) => `${r.type}:${r.path || r.title || r.type}`).join(', ')}`
    }
    if (m.imagePath) line += `\n  image: ${m.imagePath}`
    if (m.linkedMemoryIds?.length) line += `\n  linked: ${m.linkedMemoryIds.join(', ')}`
    return line
  }

  if (action === 'store') {
    let storedImage: any = null
    if (imagePath && fs.existsSync(imagePath)) {
      storedImage = await storeMemoryImageAsset(imagePath, genId(6))
    }
    const metadata = n.metadata && typeof n.metadata === 'object' && !Array.isArray(n.metadata)
      ? { ...(n.metadata as Record<string, unknown>) }
      : {}
    if (scopeMode === 'project' && scopeFilter.projectRoot && !metadata.projectRoot) {
      metadata.projectRoot = scopeFilter.projectRoot
    }
    const entry = memDb.add({
      agentId: scopeMode === 'global' ? null : currentAgentId,
      sessionId: ctx?.sessionId || null,
      category: category || 'note',
      title: key,
      content: value || '',
      metadata,
      references: Array.isArray(references) ? references : [],
      filePaths: filePaths as any,
      imagePath: storedImage?.path || undefined,
      linkedMemoryIds,
      pinned: pinned === true,
      sharedWith: Array.isArray(sharedWith) ? sharedWith : undefined,
    })
    return `Stored memory "${key}" (id: ${entry.id})`
  }

  if (action === 'get') {
    const found = memDb.get(key)
    if (!found || !canReadMemory(found)) return `Memory not found or access denied: ${key}`
    return formatEntry(found)
  }

  if (action === 'search') {
    const queries = query ? await expandQuery(query) : [key || '']
    const allResults: MemoryEntry[] = []
    const seenIds = new Set<string>()
    for (const q of queries) {
      const results = memDb.search(q, currentAgentId || undefined, { scope: scopeFilter, rerankMode })
      for (const r of results) {
        if (!seenIds.has(r.id)) {
          seenIds.add(r.id); allResults.push(r)
        }
      }
    }
    if (!allResults.length) return 'No memories found.'
    return allResults.slice(0, maxPerLookup).map(formatEntry).join('\n')
  }

  if (action === 'list') {
    const results = filterScope(memDb.list(undefined, maxPerLookup))
    return results.length ? results.map(formatEntry).join('\n') : 'No memories stored yet.'
  }

  if (action === 'delete') {
    const found = memDb.get(key)
    if (!found || !canMutateMemory(found)) return 'Memory not found or access denied.'
    memDb.delete(key)
    return `Deleted memory "${key}"`
  }

  return `Unknown action "${action}".`
}

/**
 * Register as a Built-in Plugin
 */
const MemoryPlugin: Plugin = {
  name: 'Core Memory',
  description: 'Advanced database-backed long-term memory with semantic search and graph linking.',
  hooks: {
    getAgentContext: async (ctx) => {
      const agentId = ctx.session.agentId
      if (!agentId) return null

      try { syncSessionArchiveMemory(ctx.session) } catch { /* archive sync is best-effort */ }

      const memDb = getMemoryDb()
      const memoryQuerySeed = [
        ctx.message,
        ...ctx.history
          .slice(-4)
          .filter((h) => h.role === 'user')
          .map((h) => h.text),
      ].join('\n')

      const seen = new Set<string>()
      const formatMemoryLine = (m: { category?: string; title?: string; content?: string; pinned?: boolean }) => {
        const category = String(m.category || 'note')
        const title = String(m.title || 'Untitled').replace(/\s+/g, ' ').trim()
        const snippet = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 220)
        const pin = m.pinned ? ' [pinned]' : ''
        return `- [${category}]${pin} ${title}: ${snippet}`
      }

      const pinned = memDb.listPinned(agentId, 5)
      const pinnedLines = pinned
        .filter((m) => { if (!m?.id || seen.has(m.id)) return false; seen.add(m.id); return true })
        .map(formatMemoryLine)

      const relevantSlice = Math.max(2, 6 - pinnedLines.length)
      const relevantLookup = memDb.searchWithLinked(memoryQuerySeed, agentId, 1, 10, 14)
      const relevant = relevantLookup.entries.slice(0, relevantSlice)
      const recent = memDb.list(agentId, 12).slice(0, 6)
      const relevantByTier = partitionMemoriesByTier(relevant)
      const recentByTier = partitionMemoriesByTier(recent)

      const relevantLines = relevantByTier.durable
        .filter((m) => { if (!m?.id || seen.has(m.id)) return false; seen.add(m.id); return true })
        .map(formatMemoryLine)

      const archiveLines = relevantByTier.archive
        .filter((m) => { if (!m?.id || seen.has(m.id)) return false; seen.add(m.id); return true })
        .map(formatMemoryLine)

      const recentLines = recentByTier.durable
        .filter((m) => { if (!m?.id || seen.has(m.id)) return false; seen.add(m.id); return true })
        .map(formatMemoryLine)

      const recentArchiveLines = recentByTier.archive
        .filter((m) => { if (!m?.id || seen.has(m.id)) return false; seen.add(m.id); return true })
        .map(formatMemoryLine)

      const parts: string[] = []
      if (pinnedLines.length) {
        parts.push(['## Pinned Memories', 'Always-loaded memories marked as important.', ...pinnedLines].join('\n'))
      }
      if (relevantLines.length) {
        parts.push(['## Relevant Memory Hits', 'These memories were retrieved by relevance for the current objective.', ...relevantLines].join('\n'))
      }
      if (archiveLines.length) {
        parts.push(['## Session Archive Hits', 'Past conversation snapshots that may restore context from older chats.', ...archiveLines].join('\n'))
      }
      if (recentLines.length) {
        parts.push(['## Recent Memory Notes', 'Recent durable notes that may still apply.', ...recentLines].join('\n'))
      }
      if (recentArchiveLines.length) {
        parts.push(['## Recent Session Archives', 'Recently synced conversation archives you can search instead of relying on stale live context.', ...recentArchiveLines].join('\n'))
      }

      // Memory Policy
      parts.push([
        '## My Memory',
        'I have long-term memory that persists across conversations. I use it naturally — I don\'t wait to be asked to remember things.',
        'Memory tiers: working memory is short-lived, durable memory stores stable facts and decisions, and session archives capture older conversation context for search.',
        '',
        '**Things worth remembering:**',
        '- What the user likes, dislikes, or has corrected me on',
        '- Important decisions, outcomes, and lessons learned',
        '- What I\'ve discovered about projects, codebases, or environments',
        '- Problems I\'ve hit and how I solved them',
        '- Who people are and how they relate to each other',
        '- Configuration details and environment specifics that I\'ll need again',
        '',
        '**Not worth cluttering my memory with:**',
        '- Throwaway acknowledgments or small talk',
        '- Work-in-progress that\'ll change soon (use category "working" for scratch notes)',
        '- Things already in my system prompt',
        '- Something I\'ve already stored',
        '',
        '**Good habits:**',
        '- Give memories clear titles ("User prefers dark mode" not "Note 1")',
        '- Use categories: preference, fact, learning, project, identity, decision',
        '- Search session archives before assuming older conversation context is still in the live chat history',
        '- Check what I already know before storing something new',
        '- When I learn something that corrects old knowledge, update or remove the old memory',
      ].join('\n'))

      // Pre-compaction consolidation nudge
      const msgCount = ctx.history.filter(m => m.role === 'user' || m.role === 'assistant').length
      if (msgCount > 20) {
        parts.push([
          '## Reflection & Consolidation Reminder',
          'This conversation is getting long and I might lose older context soon.',
          'Save anything important I\'ve learned, decided, or discovered to memory now. Only what matters, not every detail.',
        ].join('\n'))
      }

      return parts.join('\n\n') || null
    },
    afterToolExec: (ctx) => {
      const agentId = ctx.session.agentId
      if (!agentId) return
      const inp = ctx.input
      if (!inp || typeof inp !== 'object') return
      const action = typeof inp.action === 'string' ? inp.action : ''
      let title: string | null = null
      if (ctx.toolName === 'manage_tasks') {
        if (action === 'create') title = `Created task: ${inp.title || 'Untitled'}`
        else if (ctx.output && /status.*completed|completed.*successfully/i.test(ctx.output)) title = `Completed task: ${inp.title || inp.taskId || 'unknown'}`
      }
      if (ctx.toolName === 'manage_schedules' && action === 'create') title = `Created schedule: ${inp.name || 'Untitled'}`
      if (ctx.toolName === 'manage_agents' && action === 'create') title = `Created agent: ${inp.name || 'Untitled'}`
      if (!title) return
      try {
        const memDb = getMemoryDb()
        memDb.add({ agentId, sessionId: ctx.session.id, category: 'breadcrumb', title, content: '' })
      } catch { /* breadcrumbs are best-effort */ }
    },
    afterChatTurn: (ctx) => {
      if (ctx.internal) return
      if (ctx.source !== 'chat' && ctx.source !== 'connector') return
      const agentId = ctx.session.agentId
      if (!agentId) return
      const msg = (ctx.message || '').trim()
      const resp = (ctx.response || '').trim()
      if (msg.length < 20 || resp.length < 40) return
      if (/^(ok|okay|cool|thanks|thx|got it|nice)[.! ]*$/i.test(msg)) return
      if (resp === 'HEARTBEAT_OK') return
      const now = Date.now()
      const last = typeof ctx.session.lastAutoMemoryAt === 'number' ? ctx.session.lastAutoMemoryAt : 0
      if (last > 0 && now - last < 5 * 60 * 1000) return
      try {
        const memDb = getMemoryDb()
        const compactMessage = msg.replace(/\s+/g, ' ').slice(0, 220)
        const compactResponse = resp.replace(/\s+/g, ' ').slice(0, 700)
        const autoTitle = `[auto] ${compactMessage.slice(0, 90)}`
        const content = `source: ${ctx.source}\nuser_request: ${compactMessage}\nassistant_outcome: ${compactResponse}`
        memDb.add({ agentId, sessionId: ctx.session.id, category: 'execution', title: autoTitle, content })
        ctx.session.lastAutoMemoryAt = now
      } catch { /* auto-memory is best-effort */ }
    },
    getCapabilityDescription: () => 'I have long-term memory (`memory_tool`) — I can remember things across conversations and recall them when needed.',
    getOperatingGuidance: () => [
      'Memory: search before major tasks, store concise notes after meaningful steps. Platform preloads context each turn.',
      'For open goals, form a hypothesis and execute — do not keep re-asking broad questions.',
    ],
  } as PluginHooks,
  tools: [
    {
      name: 'memory_tool',
      description: 'Advanced long-term memory system. Use to store and recall facts across all conversations.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['store', 'get', 'search', 'list', 'delete'] },
          key: { type: 'string' },
          value: { type: 'string' },
          category: { type: 'string' },
          query: { type: 'string' },
          scope: { type: 'string', enum: ['auto', 'all', 'global', 'shared', 'agent', 'session', 'project'] },
        },
        required: ['action']
      },
      execute: async (args, context) => {
        return executeMemoryAction(args, context.session)
      }
    }
  ]
}

// Auto-register when imported
getPluginManager().registerBuiltin('memory', MemoryPlugin)

export function buildMemoryTools(bctx: ToolBuildContext) {
  if (!bctx.hasPlugin('memory')) return []
  
  return [
    tool(
      async (args) => executeMemoryAction(args, bctx.ctx),
      {
        name: 'memory_tool',
        description: MemoryPlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
