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
  const rawScope = typeof scope === 'string' ? scope : 'auto'
  const scopeMode = normalizeMemoryScopeMode(rawScope === 'shared' ? 'global' : rawScope)
  const rerankMode = rerank === 'semantic' || rerank === 'lexical' ? rerank : 'balanced'
  
  const scopeFilter = {
    mode: scopeMode,
    agentId: currentAgentId,
    sessionId: (typeof scopeSessionId === 'string' && scopeSessionId.trim()) ? scopeSessionId.trim() : (ctx?.sessionId || null),
    projectRoot: (typeof projectRoot === 'string' && projectRoot.trim()) ? projectRoot.trim() : ((project && typeof project === 'object' && 'rootPath' in project && typeof (project as Record<string, unknown>).rootPath === 'string') ? (project as Record<string, unknown>).rootPath as string : null),
  }
  
  const filterScope = (rows: MemoryEntry[]) => filterMemoriesByScope(rows, scopeFilter)
  const canReadMemory = (m: MemoryEntry) => filterScope([m]).length > 0
  const canMutateMemory = (m: MemoryEntry) => !m?.agentId || m.agentId === currentAgentId

  const limits = getMemoryLookupLimits(loadSettings())
  const maxPerLookup = limits.maxPerLookup

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
    const entry = memDb.add({
      agentId: scopeMode === 'global' ? null : currentAgentId,
      sessionId: ctx?.sessionId || null,
      category: category || 'note',
      title: key,
      content: value || '',
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
  hooks: {} as PluginHooks,
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
  if (!bctx.hasTool('memory')) return []
  
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
