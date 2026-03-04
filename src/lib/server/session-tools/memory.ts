import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import { genId } from '@/lib/id'
import { getMemoryDb, getMemoryLookupLimits, storeMemoryImageAsset } from '../memory-db'
import { loadSettings } from '../storage'
import { expandQuery } from '../query-expansion'
import type { MemoryEntry } from '@/types'
import type { ToolBuildContext } from './context'

export function buildMemoryTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { ctx, hasTool } = bctx

  if (hasTool('memory')) {
    const memDb = getMemoryDb()

    tools.push(
      tool(
        async (input) => {
          const { action, key, value, category, query, scope, filePaths, references, project, imagePath, linkedMemoryIds, depth, linkedLimit, targetIds, tags, pinned, sharedWith } = input as Record<string, any>
          try {
            const scopeMode = scope || 'auto'
            const currentAgentId = ctx?.agentId || null
            const canAccessMemory = (m: MemoryEntry) => !m?.agentId || m.agentId === currentAgentId
            const filterScope = (rows: MemoryEntry[]) => {
              if (scopeMode === 'all') return rows
              if (scopeMode === 'shared') return rows.filter((m) => !m.agentId)
              if (scopeMode === 'agent') return rows.filter((m) => currentAgentId && m.agentId === currentAgentId)
              return rows.filter(canAccessMemory)
            }

            const limits = getMemoryLookupLimits(loadSettings())
            const requestedDepth = typeof depth === 'number' ? depth : 0
            const requestedLinkedLimit = typeof linkedLimit === 'number' ? linkedLimit : limits.maxLinkedExpansion
            const effectiveDepth = Math.max(0, Math.min(requestedDepth, limits.maxDepth))
            const effectiveLinkedLimit = Math.max(0, Math.min(requestedLinkedLimit, limits.maxLinkedExpansion))
            const maxPerLookup = limits.maxPerLookup

            const normalizedLegacyRefs = Array.isArray(filePaths)
              ? filePaths.map((f: any) => ({
                  type: f.kind === 'project' ? 'project' : (f.kind === 'folder' ? 'folder' : 'file'),
                  path: f.path,
                  projectRoot: f.projectRoot,
                  projectName: f.projectName,
                  note: f.contextSnippet,
                  timestamp: typeof f.timestamp === 'number' ? f.timestamp : Date.now(),
                }))
              : []
            const normalizedRefs = Array.isArray(references) ? references : []
            if (project?.rootPath) {
              normalizedRefs.push({
                type: 'project',
                path: project.rootPath,
                projectRoot: project.rootPath,
                projectName: project.name,
                title: project.name,
                note: project.note,
                timestamp: Date.now(),
              })
            }
            const mergedRefs = [...normalizedLegacyRefs, ...normalizedRefs]

            const formatEntry = (m: any) => {
              let line = `[${m.id}] (${m.agentId ? `agent:${m.agentId}` : 'shared'}) ${m.category}/${m.title}: ${m.content}`
              if (m.reinforcementCount) line += ` (reinforced ×${m.reinforcementCount})`
              if (m.references?.length) {
                line += `\n  refs: ${m.references.map((r: any) => {
                  const core = r.path || r.title || r.type
                  const projectMeta = r.projectName ? ` @${r.projectName}` : ''
                  const existsMeta = typeof r.exists === 'boolean' ? (r.exists ? ' (exists)' : ' (missing)') : ''
                  return `${r.type}:${core}${projectMeta}${existsMeta}`
                }).join(', ')}`
              } else if (m.filePaths?.length) {
                line += `\n  files: ${m.filePaths.map((f: any) => `${f.path}${f.contextSnippet ? ` (${f.contextSnippet})` : ''}`).join(', ')}`
              }
              if (m.image?.path || m.imagePath) line += `\n  image: ${m.image?.path || m.imagePath}`
              if (m.linkedMemoryIds?.length) line += `\n  linked: ${m.linkedMemoryIds.join(', ')}`
              return line
            }

            if (action === 'store') {
              let storedImage: any = null
              if (imagePath) {
                if (!fs.existsSync(imagePath)) {
                  return `Error: image file not found: ${imagePath}`
                }
                try {
                  storedImage = await storeMemoryImageAsset(imagePath, genId(6))
                } catch {
                  return `Error: failed to process image at ${imagePath}`
                }
              }

              const entry = memDb.add({
                agentId: scopeMode === 'shared' ? null : currentAgentId,
                sessionId: ctx?.sessionId || null,
                category: category || 'note',
                title: key,
                content: value || '',
                references: mergedRefs as any,
                filePaths: filePaths as any,
                image: storedImage,
                imagePath: storedImage?.path || undefined,
                linkedMemoryIds,
                pinned: pinned === true,
                sharedWith: Array.isArray(sharedWith) ? sharedWith : undefined,
              })
              const memoryScope = entry.agentId ? 'agent' : 'shared'
              let result = `Stored ${memoryScope} memory "${key}" (id: ${entry.id})`
              if (mergedRefs.length) result += ` with ${mergedRefs.length} reference(s)`
              if (storedImage?.path) result += ` with image`
              if (linkedMemoryIds?.length) result += ` linked to ${linkedMemoryIds.length} memor${linkedMemoryIds.length === 1 ? 'y' : 'ies'}`
              return result
            }
            if (action === 'get') {
              if (effectiveDepth > 0) {
                const result = memDb.getWithLinked(key, effectiveDepth, maxPerLookup, effectiveLinkedLimit)
                if (!result) return `Memory not found: ${key}`
                const accessible = result.entries.filter(canAccessMemory)
                if (!accessible.length) return 'Error: you do not have access to that memory.'
                let output = accessible.map(formatEntry).join('\n---\n')
                if (result.truncated) output += `\n\n[Results truncated at ${maxPerLookup} memories / ${effectiveLinkedLimit} linked expansions]`
                return output
              }
              const found = memDb.get(key)
              if (!found) return `Memory not found: ${key}`
              if (!canAccessMemory(found)) return 'Error: you do not have access to that memory.'
              return formatEntry(found)
            }
            if (action === 'search') {
              const queries = query ? await expandQuery(query) : [key || '']
              
              if (effectiveDepth > 0) {
                const allResults: MemoryEntry[] = []
                const seenIds = new Set<string>()
                let anyTruncated = false
                for (const q of queries) {
                  const result = memDb.searchWithLinked(q, undefined, effectiveDepth, maxPerLookup, effectiveLinkedLimit)
                  if (result.truncated) anyTruncated = true
                  for (const r of result.entries) {
                    if (!seenIds.has(r.id)) {
                      seenIds.add(r.id)
                      allResults.push(r)
                    }
                  }
                }
                const accessible = filterScope(allResults)
                if (!accessible.length) return 'No memories found.'
                let output = accessible.slice(0, maxPerLookup).map(formatEntry).join('\n')
                if (anyTruncated) output += `\n\n[Results truncated at ${maxPerLookup} memories / ${effectiveLinkedLimit} linked expansions]`
                return output
              }

              const allResults: MemoryEntry[] = []
              const seenIds = new Set<string>()
              for (const q of queries) {
                const results = filterScope(memDb.search(q))
                for (const r of results) {
                  if (!seenIds.has(r.id)) {
                    seenIds.add(r.id)
                    allResults.push(r)
                  }
                }
              }
              if (!allResults.length) return 'No memories found.'
              return allResults.slice(0, maxPerLookup).map(formatEntry).join('\n')
            }
            if (action === 'list') {
              const results = filterScope(memDb.list(undefined, maxPerLookup))
              if (!results.length) return 'No memories stored yet.'
              return results.map(formatEntry).join('\n')
            }
            if (action === 'delete') {
              const found = memDb.get(key)
              if (!found) return `Memory not found: ${key}`
              if (!canAccessMemory(found)) return 'Error: you do not have access to that memory.'
              memDb.delete(key)
              return `Deleted memory "${key}"`
            }
            if (action === 'link') {
              if (!targetIds?.length) return 'Error: targetIds required for link action.'
              const result = memDb.link(key, targetIds, true)
              if (!result) return `Memory not found: ${key}`
              return `Linked memory "${key}" to ${targetIds.length} memor${targetIds.length === 1 ? 'y' : 'ies'} (bidirectional): ${targetIds.join(', ')}`
            }
            if (action === 'unlink') {
              if (!targetIds?.length) return 'Error: targetIds required for unlink action.'
              const result = memDb.unlink(key, targetIds, true)
              if (!result) return `Memory not found: ${key}`
              return `Unlinked ${targetIds.length} memor${targetIds.length === 1 ? 'y' : 'ies'} from "${key}" (bidirectional)`
            }
            if (action === 'knowledge_store') {
              const { addKnowledge } = await import('../memory-db')
              if (!value) return 'Error: value (content) is required for knowledge_store'
              const source = (input as Record<string, unknown>).source as string | undefined
              const sourceUrl = (input as Record<string, unknown>).sourceUrl as string | undefined
              const entry = addKnowledge({
                title: key || 'Untitled',
                content: value,
                tags: tags,
                createdByAgentId: ctx?.agentId || null,
                createdBySessionId: ctx?.sessionId || null,
                source: source || undefined,
                sourceUrl: sourceUrl || undefined,
              })
              return `Knowledge stored: "${entry.title}" (id: ${entry.id})`
            }
            if (action === 'knowledge_search') {
              const { searchKnowledge } = await import('../memory-db')
              const results = searchKnowledge(query || key || '', tags, 10)
              if (!results.length) return 'No knowledge entries found.'
              return results.map(r => {
                const meta = r.metadata as Record<string, unknown> | undefined
                const src = meta?.source as string | undefined
                const srcUrl = meta?.sourceUrl as string | undefined
                let line = `[${r.id}] ${r.title}: ${r.content.slice(0, 200)}`
                if (src && srcUrl) {
                  line += ` [${src}](${srcUrl})`
                } else if (src) {
                  line += ` (source: ${src})`
                } else if (srcUrl) {
                  line += ` (${srcUrl})`
                }
                return line
              }).join('\n---\n')
            }
            return `Unknown action "${action}". Use: store, get, search, list, delete, link, unlink, knowledge_store, or knowledge_search.`
          } catch (err: unknown) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`
          }
        },
        {
          name: 'memory_tool',
          description: `My long-term memory — things I remember across conversations. I can store personal notes, recall past context, and build up knowledge over time. Memories can be private to me or shared with other agents. I can also attach files, link related memories, and contribute to a shared knowledge base. Use \`scope: 'all'\` to search memories across all agents (useful when you need context from other agents' work).${bctx.hasTool('manage_agents') || bctx.hasTool('manage_sessions') ? ' As an orchestrator, cross-agent search with scope=all is especially useful for gathering context from sub-agents.' : ''} Actions: store, get, search, list, delete, link, unlink, knowledge_store, knowledge_search.`,
          schema: z.object({
            action: z.enum(['store', 'get', 'search', 'list', 'delete', 'link', 'unlink', 'knowledge_store', 'knowledge_search']).describe('The action to perform'),
            key: z.string().describe('For store: memory title. For get/delete/link/unlink: memory ID. For search: optional query fallback.'),
            value: z.string().optional().describe('The memory content (for store action)'),
            category: z.string().optional().describe('Category like "note", "fact", "preference", "project", "identity" (for store action, defaults to "note")'),
            query: z.string().optional().describe('Search query (alternative to key for search action)'),
            scope: z.enum(['auto', 'shared', 'agent', 'all']).optional().describe('Scope hint: auto (shared + own), shared (shared only), agent (own only), or all (every agent — cross-agent search)'),
            filePaths: z.array(z.object({
              path: z.string().describe('File or folder path'),
              contextSnippet: z.string().optional().describe('Brief context about this file reference'),
              kind: z.enum(['file', 'folder', 'project']).optional().describe('Reference type for legacy filePaths compatibility'),
              projectRoot: z.string().optional().describe('Optional project root path'),
              projectName: z.string().optional().describe('Optional project display name'),
              exists: z.boolean().optional().describe('Optional known existence state'),
              timestamp: z.number().describe('When this file was referenced'),
            })).optional().describe('File/folder references to attach to the memory (for store action)'),
            references: z.array(z.object({
              type: z.enum(['project', 'folder', 'file', 'task', 'session', 'url']),
              path: z.string().optional(),
              projectRoot: z.string().optional(),
              projectName: z.string().optional(),
              title: z.string().optional(),
              note: z.string().optional(),
              timestamp: z.number().optional(),
            })).optional().describe('Structured references attached to the memory (preferred over filePaths).'),
            project: z.object({
              rootPath: z.string().describe('Project/workspace root path'),
              name: z.string().optional().describe('Optional project display name'),
              note: z.string().optional().describe('Optional note about the project context'),
            }).optional().describe('Shortcut to add a project reference on store action.'),
            imagePath: z.string().optional().describe('Path to an image file to attach (will be compressed and stored). For store action.'),
            linkedMemoryIds: z.array(z.string()).optional().describe('IDs of other memories to link to (for store action)'),
            depth: z.number().optional().describe('How deep to traverse linked memories (for get/search). Respects configured maxDepth limit. Default: 0 (no traversal).'),
            linkedLimit: z.number().optional().describe('Max linked memories expanded during traversal. Respects configured server cap.'),
            targetIds: z.array(z.string()).optional().describe('Memory IDs to link/unlink (for link/unlink actions)'),
            tags: z.array(z.string()).optional().describe('Tags for categorizing knowledge entries'),
            source: z.string().optional().describe("Source of the knowledge, e.g. 'user', 'web', 'document'"),
            sourceUrl: z.string().optional().describe('URL where the knowledge was sourced from'),
            pinned: z.boolean().optional().describe('Mark memory as pinned (always preloaded in agent context). For store action.'),
            sharedWith: z.array(z.string()).optional().describe('Agent IDs to share this memory with (for store action). They can read it in their context.'),
          }),
        },
      ),
    )
  }

  return tools
}
