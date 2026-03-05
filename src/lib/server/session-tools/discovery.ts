import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { ToolBuildContext } from './context'
import { getPluginManager } from '../plugins'
import type { Plugin, PluginHooks, ClawHubSkill } from '@/types'
import { searchClawHub } from '../clawhub-client'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { pluginIdMatches } from '../tool-aliases'
import { loadSessions } from '../storage'

/**
 * Unified Discovery Logic
 */
async function executeDiscoveryAction(args: Record<string, unknown>, bctx?: ToolBuildContext) {
  const normalized = normalizeToolInputArgs(args)
  const action = normalized.action
  const approved = normalized.approved
  const pluginId = typeof normalized.pluginId === 'string'
    ? normalized.pluginId.trim()
    : typeof normalized.plugin_id === 'string'
      ? normalized.plugin_id.trim()
      : undefined
  const url = typeof normalized.url === 'string' ? normalized.url.trim() : undefined
  const reason = normalized.reason as string | undefined
  const manager = getPluginManager()
  const q = typeof normalized.query === 'string' ? normalized.query : ''

  console.log('[discovery] Executing action:', action, { query: q, pluginId })

  try {
    switch (action) {
      case 'list':
      case 'discover': {
        const plugins = manager.listPlugins()
        return JSON.stringify(plugins.map(p => ({
          id: p.filename,
          name: p.name,
          description: p.description,
          enabled: p.enabled,
          isBuiltin: !p.filename.endsWith('.js') && !p.filename.endsWith('.mjs')
        })), null, 2)
      }
      case 'search_marketplace': {
        const results: Record<string, unknown>[] = []
        
        try {
          console.log('[discovery] Searching ClawHub...')
          const hubResults = await searchClawHub(q)
          if (hubResults && hubResults.skills) {
            results.push(...hubResults.skills.map((s) => ({
              id: s.id,
              name: s.name,
              description: s.description,
              author: s.author,
              source: 'clawhub',
              url: (s as ClawHubSkill & { rawUrl?: string }).rawUrl ?? s.url
            })))
          }
        } catch (err: unknown) {
          console.error('[discovery] ClawHub search failed:', err instanceof Error ? err.message : String(err))
        }

        try {
          console.log('[discovery] Searching SwarmClaw registry...')
          const scRes = await fetch('https://swarmclaw.ai/registry/plugins.json', { signal: AbortSignal.timeout(5000) })
          if (scRes.ok) {
            const scPlugins = await scRes.json()
            const filtered = (scPlugins as Record<string, unknown>[]).filter((p: Record<string, unknown>) =>
              !q || (String(p.name || '')).toLowerCase().includes(q.toLowerCase()) || (String(p.description || '')).toLowerCase().includes(q.toLowerCase())
            )
            results.push(...filtered.map(p => ({ ...p, source: 'swarmclaw' })))
          }
        } catch (err: unknown) {
          console.error('[discovery] SC Registry search failed:', err instanceof Error ? err.message : String(err))
        }

        if (results.length === 0) {
          return 'No marketplace plugins found for your query.'
        }

        return JSON.stringify(results, null, 2)
      }
      case 'request_access': {
        if (!pluginId) {
          return JSON.stringify({ error: 'pluginId is required for request_access. Use "discover" first to find the plugin filename.' })
        }
        // Check if the agent already has access via alias expansion (e.g. manage_platform includes manage_secrets)
        if (bctx?.ctx?.sessionId) {
          const allSessions = loadSessions()
          const currentSession = allSessions[bctx.ctx.sessionId]
          if (currentSession && pluginIdMatches(currentSession.tools, pluginId)) {
            return JSON.stringify({
              alreadyGranted: true,
              pluginId,
              message: `You already have access to "${pluginId}" — proceed to use it directly.`,
            })
          }
        }
        const { requestApproval } = await import('../approvals')
        requestApproval({
          category: 'tool_access',
          title: `Enable Plugin: ${pluginId}`,
          description: reason || `Agent is requesting access to the "${pluginId}" plugin.`,
          data: { toolId: pluginId, pluginId, requestedBy: bctx?.ctx?.agentId || 'unknown', reason: reason || '' },
          agentId: bctx?.ctx?.agentId,
          sessionId: bctx?.ctx?.sessionId,
        })
        return JSON.stringify({
          type: 'plugin_request',
          pluginId,
          toolId: pluginId,
          reason,
          message: `Plugin access request sent to user for "${pluginId}". Once granted, I'll automatically continue.`,
        })
      }
      case 'install_request': {
        if (!url) {
          return JSON.stringify({ error: 'url is required for install_request.' })
        }
        if (approved !== true) {
          const { requestApproval } = await import('../approvals')
          requestApproval({
            category: 'plugin_install',
            title: `Install Plugin${pluginId ? `: ${pluginId}` : ' from URL'}`,
            description: reason || `Agent wants to install a plugin${url ? ` from ${url}` : ''}.`,
            data: { url, pluginId: pluginId || '', requestedBy: bctx?.ctx?.agentId || 'unknown', reason: reason || '' },
            agentId: bctx?.ctx?.agentId,
            sessionId: bctx?.ctx?.sessionId,
          })
          return JSON.stringify({
            type: 'plugin_install_request',
            url,
            pluginId,
            reason,
            message: `I'm requesting to install a new plugin from ${url}. This will add new capabilities to the platform.`
          })
        }
        
        return `Installation approved. Please go to the Plugins manager and install from: ${url}`
      }
      default:
        return `Error: Unknown action "${action}"`
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[discovery] executeDiscoveryAction failed:', msg)
    return `Error: ${msg}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const DiscoveryPlugin: Plugin = {
  name: 'Core Discovery',
  description: 'Discover available plugins, search marketplaces, request access, or suggest new installs.',
  hooks: {} as PluginHooks,
  tools: [
    {
      name: 'manage_capabilities',
      description: 'Search for available plugins locally or in external marketplaces.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['discover', 'search_marketplace', 'request_access', 'install_request'] },
          query: { type: 'string', description: 'Search term for marketplace' },
          pluginId: { type: 'string', description: 'The ID or filename of the plugin' },
          url: { type: 'string', description: 'URL for new plugin install request' },
          reason: { type: 'string', description: 'Why you need this capability' }
        },
        required: ['action', 'reason']
      },
      execute: async (args) => executeDiscoveryAction(args)
    }
  ]
}

getPluginManager().registerBuiltin('discovery', DiscoveryPlugin)

export function buildDiscoveryTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  // Always allow agents to discover what they can do
  return [
    tool(
      async (args) => executeDiscoveryAction(args, bctx),
      {
        name: 'manage_capabilities',
        description: DiscoveryPlugin.tools![0].description,
        schema: z.object({
          action: z.enum(['discover', 'search_marketplace', 'request_access', 'install_request']).describe('The discovery action to perform'),
          query: z.string().optional().describe('The search query for marketplace actions'),
          pluginId: z.string().optional(),
          url: z.string().optional(),
          reason: z.string().describe('Why you need to perform this discovery action')
        })
      }
    )
  ]
}
