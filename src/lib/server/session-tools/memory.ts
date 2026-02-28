import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import crypto from 'crypto'
import { getMemoryDb, getMemoryLookupLimits, storeMemoryImageAsset } from '../memory-db'
import { loadSettings } from '../storage'
import type { ToolBuildContext } from './context'

export function buildMemoryTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { ctx, hasTool } = bctx

  if (hasTool('memory')) {
    const memDb = getMemoryDb()

    tools.push(
      tool(
        async ({ action, key, value, category, query, scope, filePaths, references, project, imagePath, linkedMemoryIds, depth, linkedLimit, targetIds, tags }) => {
          try {
            const scopeMode = scope || 'auto'
            const currentAgentId = ctx?.agentId || null
            const canAccessMemory = (m: any) => !m?.agentId || m.agentId === currentAgentId
            const filterScope = (rows: any[]) => {
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
                  storedImage = await storeMemoryImageAsset(imagePath, crypto.randomBytes(6).toString('hex'))
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
              if (effectiveDepth > 0) {
                const result = memDb.searchWithLinked(query || key, undefined, effectiveDepth, maxPerLookup, effectiveLinkedLimit)
                const accessible = filterScope(result.entries)
                if (!accessible.length) return 'No memories found.'
                let output = accessible.map(formatEntry).join('\n')
                if (result.truncated) output += `\n\n[Results truncated at ${maxPerLookup} memories / ${effectiveLinkedLimit} linked expansions]`
                return output
              }
              const results = filterScope(memDb.search(query || key))
              if (!results.length) return 'No memories found.'
              return results.slice(0, maxPerLookup).map(formatEntry).join('\n')
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
              const entry = addKnowledge({
                title: key || 'Untitled',
                content: value,
                tags: tags,
                createdByAgentId: ctx?.agentId || null,
                createdBySessionId: ctx?.sessionId || null,
              })
              return `Knowledge stored: "${entry.title}" (id: ${entry.id})`
            }
            if (action === 'knowledge_search') {
              const { searchKnowledge } = await import('../memory-db')
              const results = searchKnowledge(query || key || '', tags, 10)
              if (!results.length) return 'No knowledge entries found.'
              return results.map(r => `[${r.id}] ${r.title}: ${r.content.slice(0, 200)}`).join('\n---\n')
            }
            return `Unknown action "${action}". Use: store, get, search, list, delete, link, unlink, knowledge_store, or knowledge_search.`
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: 'memory_tool',
          description: 'Store and retrieve long-term memories that persist across sessions. Memories can be shared or agent-scoped. Supports file references, image attachments, and linking memories together with depth traversal. Also supports a cross-agent knowledge base via "knowledge_store" and "knowledge_search". Use "store", "get", "search", "list", "delete", "link", "unlink", "knowledge_store", or "knowledge_search".',
          schema: z.object({
            action: z.enum(['store', 'get', 'search', 'list', 'delete', 'link', 'unlink', 'knowledge_store', 'knowledge_search']).describe('The action to perform'),
            key: z.string().describe('For store: memory title. For get/delete/link/unlink: memory ID. For search: optional query fallback.'),
            value: z.string().optional().describe('The memory content (for store action)'),
            category: z.string().optional().describe('Category like "note", "fact", "preference", "project", "identity" (for store action, defaults to "note")'),
            query: z.string().optional().describe('Search query (alternative to key for search action)'),
            scope: z.enum(['auto', 'shared', 'agent']).optional().describe('Scope hint: auto (shared + own), shared, or agent'),
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
          }),
        },
      ),
    )
  }

  return tools
}
