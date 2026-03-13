import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { ToolBuildContext } from './context'
import { getPluginManager, normalizeMarketplacePluginUrl } from '../plugins'
import { listNativeCapabilities, registerNativeCapability } from '../native-capabilities'
import type { Plugin, PluginHooks, ClawHubSkill } from '@/types'
import { searchClawHub } from '@/lib/server/skills/clawhub-client'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { pluginIdMatches } from '../tool-aliases'
import { loadSessions, patchAgent, patchSession } from '../storage'
import { inferPluginPublisherSourceFromUrl } from '@/lib/plugin-sources'
import { errorMessage } from '@/lib/shared-utils'
import { getEnabledCapabilityIds, isExternalExtensionId, normalizeCapabilitySelection } from '@/lib/capability-selection'

function grantCapabilitySelection(current: {
  tools?: string[] | null
  extensions?: string[] | null
}, requestedId: string): {
  tools: string[]
  extensions: string[]
  changed: boolean
} {
  const normalized = normalizeCapabilitySelection({
    tools: current.tools,
    extensions: current.extensions,
  })
  const nextTools = [...normalized.tools]
  const nextExtensions = [...normalized.extensions]
  const targetList = isExternalExtensionId(requestedId) ? nextExtensions : nextTools
  if (targetList.includes(requestedId)) {
    return { ...normalized, changed: false }
  }
  targetList.push(requestedId)
  return {
    tools: nextTools,
    extensions: nextExtensions,
    changed: true,
  }
}

/**
 * Unified Discovery Logic
 */
async function executeDiscoveryAction(args: Record<string, unknown>, bctx?: ToolBuildContext) {
  const normalized = normalizeToolInputArgs(args)
  const action = normalized.action
  const approved = normalized.approved
  const explicitPluginId = typeof normalized.pluginId === 'string'
    ? normalized.pluginId.trim()
    : typeof normalized.plugin_id === 'string'
      ? normalized.plugin_id.trim()
      : typeof normalized.toolId === 'string'
        ? normalized.toolId.trim()
        : typeof normalized.tool_id === 'string'
          ? normalized.tool_id.trim()
          : typeof normalized.tool === 'string'
            ? normalized.tool.trim()
            : typeof normalized.name === 'string'
              ? normalized.name.trim()
              : undefined
  const url = typeof normalized.url === 'string' ? normalized.url.trim() : undefined
  const reason = normalized.reason as string | undefined
  const manager = getPluginManager()
  const q = typeof normalized.query === 'string' ? normalized.query : ''
  const pluginId = explicitPluginId || (action === 'request_access' ? q.trim() : '')

  console.log('[discovery] Executing action:', action, { query: q, pluginId })

  try {
    switch (action) {
      case 'list':
      case 'discover': {
        const nativeCapabilities = listNativeCapabilities()
        const nativeIds = new Set(nativeCapabilities.map((entry) => entry.filename))
        const capabilities = [...nativeCapabilities, ...manager.listPlugins()]
        const currentSession = bctx?.ctx?.sessionId ? loadSessions()[bctx.ctx.sessionId] : null
        const sessionPlugins = getEnabledCapabilityIds(currentSession)
        return JSON.stringify(capabilities.map(p => ({
          id: p.filename,
          name: p.name,
          description: p.description,
          enabled: p.enabled,
          granted: pluginIdMatches(sessionPlugins, p.filename),
          availableNow: pluginIdMatches(sessionPlugins, p.filename) && (nativeIds.has(p.filename) || !manager.isExplicitlyDisabled(p.filename)),
          isBuiltin: !isExternalExtensionId(p.filename)
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
              catalogSource: 'clawhub',
              url: (s as ClawHubSkill & { rawUrl?: string }).rawUrl ?? s.url
            })))
          }
        } catch (err: unknown) {
          console.error('[discovery] ClawHub search failed:', errorMessage(err))
        }

        try {
          console.log('[discovery] Searching SwarmClaw registry...')
          const registryResults = new Map<string, Record<string, unknown>>()
          const registries = [
            { url: 'https://swarmclaw.ai/registry/plugins.json', catalogSource: 'swarmclaw-site' },
            { url: 'https://raw.githubusercontent.com/swarmclawai/swarmforge/main/registry.json', catalogSource: 'swarmforge' },
          ] as const
          for (const registry of registries) {
            const scRes = await fetch(registry.url, { signal: AbortSignal.timeout(5000) })
            if (!scRes.ok) continue
            const scPlugins = await scRes.json()
            const filtered = (scPlugins as Record<string, unknown>[]).filter((p: Record<string, unknown>) =>
              !q || (String(p.name || '')).toLowerCase().includes(q.toLowerCase()) || (String(p.description || '')).toLowerCase().includes(q.toLowerCase())
            )
            for (const p of filtered) {
              const id = String(p.id || p.name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '_')
              if (!id || registryResults.has(id)) continue
              const url = normalizeMarketplacePluginUrl(String(p.url || ''))
              registryResults.set(id, {
                ...p,
                id,
                url,
                source: inferPluginPublisherSourceFromUrl(url) || 'swarmforge',
                catalogSource: registry.catalogSource,
              })
            }
          }
          results.push(...registryResults.values())
        } catch (err: unknown) {
          console.error('[discovery] SC Registry search failed:', errorMessage(err))
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
          const grantedTools = getEnabledCapabilityIds(currentSession)
          if (currentSession && pluginIdMatches(grantedTools, pluginId)) {
            return JSON.stringify({
              alreadyGranted: true,
              alreadyAvailable: true,
              pluginId,
              message: `You already have access to "${pluginId}" in this session. Call "${pluginId}" directly now instead of using manage_capabilities again.`,
            })
          }
        }
        if (bctx?.ctx?.sessionId) {
          patchSession(bctx.ctx.sessionId, (currentSession) => {
            if (!currentSession) return currentSession
            const nextSelection = grantCapabilitySelection(currentSession, pluginId)
            if (!nextSelection.changed) return currentSession
            currentSession.tools = nextSelection.tools
            currentSession.extensions = nextSelection.extensions
            currentSession.updatedAt = Date.now()
            return currentSession
          })
        } else if (bctx?.ctx?.agentId) {
          patchAgent(bctx.ctx.agentId, (currentAgent) => {
            if (!currentAgent) return currentAgent
            const nextSelection = grantCapabilitySelection(currentAgent, pluginId)
            if (!nextSelection.changed) return currentAgent
            currentAgent.tools = nextSelection.tools
            currentAgent.extensions = nextSelection.extensions
            currentAgent.updatedAt = Date.now()
            return currentAgent
          })
        }
        return JSON.stringify({
          type: 'capability_access_granted',
          alreadyGranted: true,
          pluginId,
          toolId: pluginId,
          reason,
          message: `Access to "${pluginId}" was granted immediately. It will be available on the next agent turn.`,
        })
      }
      case 'install_request': {
        if (!url) {
          return JSON.stringify({ error: 'url is required for install_request.' })
        }
        const safeName = (pluginId || url.split('/').pop() || 'plugin').replace(/[^a-zA-Z0-9._-]/g, '_')
        const resolvedFilename = safeName.endsWith('.js') || safeName.endsWith('.mjs') ? safeName : `${safeName}.js`
        const installed = await manager.installPluginFromUrl(url, resolvedFilename, {
          createdByAgentId: bctx?.ctx?.agentId || undefined,
          requestedByAgentId: bctx?.ctx?.agentId || undefined,
          installReason: reason || '',
          approved,
        })
        if (bctx?.ctx?.sessionId) {
          patchSession(bctx.ctx.sessionId, (currentSession) => {
            if (!currentSession) return currentSession
            const nextSelection = grantCapabilitySelection(currentSession, installed.filename)
            if (!nextSelection.changed) return currentSession
            currentSession.tools = nextSelection.tools
            currentSession.extensions = nextSelection.extensions
            currentSession.updatedAt = Date.now()
            return currentSession
          })
        }
        return JSON.stringify({
          type: 'plugin_install_result',
          pluginId: pluginId || installed.filename,
          filename: installed.filename,
          url: installed.sourceUrl,
          message: `Installed plugin "${installed.filename}" from ${installed.sourceUrl}. It will be available on the next agent turn.`,
        })
      }
      default:
        return `Error: Unknown action "${action}"`
    }
  } catch (err: unknown) {
    const msg = errorMessage(err)
    console.error('[discovery] executeDiscoveryAction failed:', msg)
    return `Error: ${msg}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const DiscoveryPlugin: Plugin = {
  name: 'Capability Discovery',
  description: 'Discover built-in tools and external extensions, search marketplaces, request access, or suggest new installs.',
  hooks: {} as PluginHooks,
  tools: [
    {
      name: 'manage_capabilities',
      description: 'Discover available built-in tools or external extensions, search marketplaces, or request access to a direct tool or extension id with action="request_access" (for example "shell", "manage_schedules", or "delegate").',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['discover', 'search_marketplace', 'request_access', 'install_request'] },
          query: { type: 'string', description: 'Search term for marketplace, or the direct tool/extension name for request_access' },
          pluginId: { type: 'string', description: 'The exact tool or extension name to request, such as "shell" or "manage_schedules"' },
          url: { type: 'string', description: 'URL for new plugin install request' },
          reason: { type: 'string', description: 'Why you need this capability' }
        },
        required: ['action', 'reason']
      },
      execute: async (args) => executeDiscoveryAction(args)
    }
  ]
}

registerNativeCapability('discovery', DiscoveryPlugin)

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
          query: z.string().optional().describe('The marketplace query, or the direct tool/extension name to request access to'),
          pluginId: z.string().optional().describe('The exact tool or extension name to request, such as "shell" or "manage_schedules"'),
          url: z.string().optional(),
          reason: z.string().describe('Why you need to perform this discovery action')
        })
      }
    )
  ]
}
