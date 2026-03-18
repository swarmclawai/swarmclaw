import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { ToolBuildContext } from './context'
import { getExtensionManager, normalizeMarketplaceExtensionUrl } from '../extensions'
import { listNativeCapabilities, registerNativeCapability } from '../native-capabilities'
import type { Extension, ExtensionHooks, ClawHubSkill } from '@/types'
import { searchClawHub } from '@/lib/server/skills/clawhub-client'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { extensionIdMatches } from '../tool-aliases'
import { loadSessions, patchAgent, patchSession } from '../storage'
import { inferExtensionPublisherSourceFromUrl } from '@/lib/extension-sources'
import { errorMessage } from '@/lib/shared-utils'
import { getEnabledCapabilityIds, isExternalExtensionId, normalizeCapabilitySelection } from '@/lib/capability-selection'
import { log } from '@/lib/server/logger'

const TAG = 'session-tools-discovery'

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
  const explicitExtensionId = typeof normalized.extensionId === 'string'
    ? normalized.extensionId.trim()
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
  const manager = getExtensionManager()
  const q = typeof normalized.query === 'string' ? normalized.query : ''
  const extensionId = explicitExtensionId || (action === 'request_access' ? q.trim() : '')

  log.info(TAG, 'Executing action:', { action, query: q, extensionId })

  try {
    switch (action) {
      case 'list':
      case 'discover': {
        const nativeCapabilities = listNativeCapabilities()
        const nativeIds = new Set(nativeCapabilities.map((entry) => entry.filename))
        const capabilities = [...nativeCapabilities, ...manager.listExtensions()]
        const currentSession = bctx?.ctx?.sessionId ? loadSessions()[bctx.ctx.sessionId] : null
        const sessionExtensions = getEnabledCapabilityIds(currentSession)
        return JSON.stringify(capabilities.map(p => ({
          id: p.filename,
          name: p.name,
          description: p.description,
          enabled: p.enabled,
          granted: extensionIdMatches(sessionExtensions, p.filename),
          availableNow: extensionIdMatches(sessionExtensions, p.filename) && (nativeIds.has(p.filename) || !manager.isExplicitlyDisabled(p.filename)),
          isBuiltin: !isExternalExtensionId(p.filename)
        })), null, 2)
      }
      case 'search_marketplace': {
        const results: Record<string, unknown>[] = []
        
        try {
          log.info(TAG, 'Searching ClawHub...')
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
          log.error(TAG, 'ClawHub search failed:', errorMessage(err))
        }

        try {
          log.info(TAG, 'Searching SwarmClaw registry...')
          const registryResults = new Map<string, Record<string, unknown>>()
          const registries = [
            { url: 'https://swarmclaw.ai/registry/extensions.json', catalogSource: 'swarmclaw-site' },
            { url: 'https://raw.githubusercontent.com/swarmclawai/swarmforge/main/registry.json', catalogSource: 'swarmforge' },
          ] as const
          for (const registry of registries) {
            const scRes = await fetch(registry.url, { signal: AbortSignal.timeout(5000) })
            if (!scRes.ok) continue
            const scExtensions = await scRes.json()
            const filtered = (scExtensions as Record<string, unknown>[]).filter((p: Record<string, unknown>) =>
              !q || (String(p.name || '')).toLowerCase().includes(q.toLowerCase()) || (String(p.description || '')).toLowerCase().includes(q.toLowerCase())
            )
            for (const p of filtered) {
              const id = String(p.id || p.name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '_')
              if (!id || registryResults.has(id)) continue
              const url = normalizeMarketplaceExtensionUrl(String(p.url || ''))
              registryResults.set(id, {
                ...p,
                id,
                url,
                source: inferExtensionPublisherSourceFromUrl(url) || 'swarmforge',
                catalogSource: registry.catalogSource,
              })
            }
          }
          results.push(...registryResults.values())
        } catch (err: unknown) {
          log.error(TAG, 'SC Registry search failed:', errorMessage(err))
        }

        if (results.length === 0) {
          return 'No marketplace extensions found for your query.'
        }

        return JSON.stringify(results, null, 2)
      }
      case 'request_access': {
        if (!extensionId) {
          return JSON.stringify({ error: 'extensionId is required for request_access. Use "discover" first to find the extension filename.' })
        }
        // Check if the agent already has access via alias expansion (e.g. manage_platform includes manage_secrets)
        if (bctx?.ctx?.sessionId) {
          const allSessions = loadSessions()
          const currentSession = allSessions[bctx.ctx.sessionId]
          const grantedTools = getEnabledCapabilityIds(currentSession)
          if (currentSession && extensionIdMatches(grantedTools, extensionId)) {
            return JSON.stringify({
              alreadyGranted: true,
              alreadyAvailable: true,
              extensionId,
              message: `You already have access to "${extensionId}" in this session. Call "${extensionId}" directly now instead of using manage_capabilities again.`,
            })
          }
        }
        if (bctx?.ctx?.sessionId) {
          patchSession(bctx.ctx.sessionId, (currentSession) => {
            if (!currentSession) return currentSession
            const nextSelection = grantCapabilitySelection(currentSession, extensionId)
            if (!nextSelection.changed) return currentSession
            currentSession.tools = nextSelection.tools
            currentSession.extensions = nextSelection.extensions
            currentSession.updatedAt = Date.now()
            return currentSession
          })
        } else if (bctx?.ctx?.agentId) {
          patchAgent(bctx.ctx.agentId, (currentAgent) => {
            if (!currentAgent) return currentAgent
            const nextSelection = grantCapabilitySelection(currentAgent, extensionId)
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
          extensionId,
          toolId: extensionId,
          reason,
          message: `Access to "${extensionId}" was granted immediately. It will be available on the next agent turn.`,
        })
      }
      case 'install_request': {
        if (!url) {
          return JSON.stringify({ error: 'url is required for install_request.' })
        }
        const safeName = (extensionId || url.split('/').pop() || 'extension').replace(/[^a-zA-Z0-9._-]/g, '_')
        const resolvedFilename = safeName.endsWith('.js') || safeName.endsWith('.mjs') ? safeName : `${safeName}.js`
        const installed = await manager.installExtensionFromUrl(url, resolvedFilename, {
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
          type: 'extension_install_result',
          extensionId: extensionId || installed.filename,
          filename: installed.filename,
          url: installed.sourceUrl,
          message: `Installed extension "${installed.filename}" from ${installed.sourceUrl}. It will be available on the next agent turn.`,
        })
      }
      default:
        return `Error: Unknown action "${action}"`
    }
  } catch (err: unknown) {
    const msg = errorMessage(err)
    log.error(TAG, 'executeDiscoveryAction failed:', msg)
    return `Error: ${msg}`
  }
}

/**
 * Register as a Built-in Extension
 */
const DiscoveryExtension: Extension = {
  name: 'Capability Discovery',
  description: 'Discover built-in tools and external extensions, search marketplaces, request access, or suggest new installs.',
  hooks: {} as ExtensionHooks,
  tools: [
    {
      name: 'manage_capabilities',
      description: 'Discover available built-in tools or external extensions, search marketplaces, or request access to a direct tool or extension id with action="request_access" (for example "shell", "manage_schedules", or "delegate").',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['discover', 'search_marketplace', 'request_access', 'install_request'] },
          query: { type: 'string', description: 'Search term for marketplace, or the direct tool/extension name for request_access' },
          extensionId: { type: 'string', description: 'The exact tool or extension name to request, such as "shell" or "manage_schedules"' },
          url: { type: 'string', description: 'URL for new extension install request' },
          reason: { type: 'string', description: 'Why you need this capability' }
        },
        required: ['action', 'reason']
      },
      execute: async (args) => executeDiscoveryAction(args as Record<string, unknown>)
    }
  ]
}

registerNativeCapability('discovery', DiscoveryExtension)

export function buildDiscoveryTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  // Always allow agents to discover what they can do
  return [
    tool(
      async (args) => executeDiscoveryAction(args as Record<string, unknown>, bctx),
      {
        name: 'manage_capabilities',
        description: DiscoveryExtension.tools![0].description,
        schema: z.object({
          action: z.enum(['discover', 'search_marketplace', 'request_access', 'install_request']).describe('The discovery action to perform'),
          query: z.string().optional().describe('The marketplace query, or the direct tool/extension name to request access to'),
          extensionId: z.string().optional().describe('The exact tool or extension name to request, such as "shell" or "manage_schedules"'),
          url: z.string().optional(),
          reason: z.string().describe('Why you need to perform this discovery action')
        })
      }
    )
  ]
}
