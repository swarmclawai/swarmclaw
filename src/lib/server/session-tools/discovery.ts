import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { ToolBuildContext } from './context'
import { getPluginManager, normalizeMarketplacePluginUrl } from '../plugins'
import type { Plugin, PluginHooks, ClawHubSkill } from '@/types'
import { searchClawHub } from '../clawhub-client'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { pluginIdMatches } from '../tool-aliases'
import { loadSessions } from '../storage'
import { inferPluginPublisherSourceFromUrl } from '@/lib/plugin-sources'

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function buildDiscoveryApprovalResumeInput(approval: import('@/types').ApprovalRequest): Record<string, unknown> | null {
  if (approval.category !== 'plugin_install') return null
  const url = trimString(approval.data.url)
  if (!url) return null
  const pluginId = trimString(approval.data.pluginId)
  const reason = trimString(approval.data.reason)
  return {
    action: 'install_request',
    url,
    pluginId: pluginId || undefined,
    reason: reason || `Approved install request for ${url}`,
    approved: true,
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
        const plugins = manager.listPlugins()
        const currentSession = bctx?.ctx?.sessionId ? loadSessions()[bctx.ctx.sessionId] : null
        const sessionPlugins = currentSession?.plugins || currentSession?.tools || []
        return JSON.stringify(plugins.map(p => ({
          id: p.filename,
          name: p.name,
          description: p.description,
          enabled: p.enabled,
          granted: pluginIdMatches(sessionPlugins, p.filename),
          availableNow: pluginIdMatches(sessionPlugins, p.filename) && !manager.isExplicitlyDisabled(p.filename),
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
              catalogSource: 'clawhub',
              url: (s as ClawHubSkill & { rawUrl?: string }).rawUrl ?? s.url
            })))
          }
        } catch (err: unknown) {
          console.error('[discovery] ClawHub search failed:', err instanceof Error ? err.message : String(err))
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
          const grantedTools = currentSession?.plugins || currentSession?.tools || []
          if (currentSession && pluginIdMatches(grantedTools, pluginId)) {
            return JSON.stringify({
              alreadyGranted: true,
              alreadyAvailable: true,
              pluginId,
              message: `You already have access to "${pluginId}" in this session. Call "${pluginId}" directly now instead of using manage_capabilities again.`,
            })
          }
        }
        const { requestApprovalMaybeAutoApprove } = await import('../approvals')
        const approval = await requestApprovalMaybeAutoApprove({
          category: 'tool_access',
          title: `Enable Plugin: ${pluginId}`,
          description: reason || `Agent is requesting access to the "${pluginId}" plugin.`,
          data: { toolId: pluginId, pluginId, requestedBy: bctx?.ctx?.agentId || 'unknown', reason: reason || '' },
          agentId: bctx?.ctx?.agentId,
          sessionId: bctx?.ctx?.sessionId,
        })
        if (approval.status === 'approved') {
          return JSON.stringify({
            alreadyGranted: true,
            pluginId,
            toolId: pluginId,
            autoApproved: true,
            message: `Access to "${pluginId}" was auto-approved and granted. It will be available on the next agent turn.`,
          })
        }
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
          const { requestApprovalMaybeAutoApprove } = await import('../approvals')
          const approval = await requestApprovalMaybeAutoApprove({
            category: 'plugin_install',
            title: `Install Plugin${pluginId ? `: ${pluginId}` : ' from URL'}`,
            description: reason || `Agent wants to install a plugin${url ? ` from ${url}` : ''}.`,
            data: { url, pluginId: pluginId || '', requestedBy: bctx?.ctx?.agentId || 'unknown', reason: reason || '' },
            agentId: bctx?.ctx?.agentId,
            sessionId: bctx?.ctx?.sessionId,
          })
          if (approval.status === 'approved') {
            return JSON.stringify({
              type: 'plugin_install_request',
              url,
              pluginId,
              autoApproved: true,
              message: `Plugin install from ${url} was auto-approved and has been applied.`,
            })
          }
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
  hooks: {
    getApprovalGuidance: ({ approval, phase, approved }) => {
      if (approval.category !== 'plugin_install') return null
      if (phase === 'request') {
        return [
          'When this approval is granted, continue with `manage_capabilities` for the exact approved install request instead of asking again in prose.',
          'Do not change the approved plugin URL or pluginId unless newer tool evidence proves the approved source is invalid.',
        ]
      }
      if (phase === 'connector_reminder') {
        return 'Approving this lets the agent resume the approved plugin install request without repeating marketplace research.'
      }
      if (approved !== true) {
        return 'Do not retry the rejected install request unless the plugin source or requested capability materially changes.'
      }
      const resumeInput = buildDiscoveryApprovalResumeInput(approval)
      const lines = [
        'Resume immediately with `manage_capabilities` for the approved install request.',
        'Do not repeat the same marketplace search or install request once approval has been granted.',
      ]
      if (resumeInput) {
        lines.push(`Exact tool input: ${JSON.stringify(resumeInput)}`)
      }
      return lines
    },
  } as PluginHooks,
  tools: [
    {
      name: 'manage_capabilities',
      description: 'Discover currently available tools, search marketplaces, or request access to a direct tool/plugin name with action="request_access" (for example "shell", "manage_schedules", or "delegate").',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['discover', 'search_marketplace', 'request_access', 'install_request'] },
          query: { type: 'string', description: 'Search term for marketplace, or the direct tool/plugin name for request_access' },
          pluginId: { type: 'string', description: 'The exact tool/plugin name to request, such as "shell" or "manage_schedules"' },
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
          query: z.string().optional().describe('The marketplace query, or the direct tool/plugin name to request access to'),
          pluginId: z.string().optional().describe('The exact tool/plugin name to request, such as "shell" or "manage_schedules"'),
          url: z.string().optional(),
          reason: z.string().describe('Why you need to perform this discovery action')
        })
      }
    )
  ]
}
