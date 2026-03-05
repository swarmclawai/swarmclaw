import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { ToolBuildContext } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

/**
 * Core OpenClaw Nodes Execution Logic
 */
async function executeNodesAction(args: any) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const action = normalized.action as string | undefined
  const nodeId = (normalized.nodeId ?? normalized.node_id) as string | undefined
  const message = normalized.message as string | undefined
  const params = normalized.params as Record<string, unknown> | undefined
  try {
    const { listRunningConnectors, getRunningInstance } = await import('../connectors/manager')
    const openclawConnectors = listRunningConnectors('openclaw')
    if (!openclawConnectors.length) {
      return JSON.stringify({
        status: 'not_connected',
        message: 'No running OpenClaw connector found.',
        hint: 'Start an OpenClaw connector in the Connectors panel, then retry.',
      })
    }
    const inst = getRunningInstance(openclawConnectors[0].id)
    if (!inst) {
      return JSON.stringify({
        status: 'not_connected',
        message: 'OpenClaw connector instance not accessible.',
        connectorId: openclawConnectors[0].id,
      })
    }

    if (action === 'list') {
      return JSON.stringify({ status: 'nodes.list not supported on gateway yet', connectorId: openclawConnectors[0].id })
    }
    if (action === 'notify') {
      return JSON.stringify({ status: 'nodes.notify not supported on gateway yet', nodeId, message })
    }
    if (action === 'invoke') {
      return JSON.stringify({ status: 'nodes.invoke not supported on gateway yet', nodeId, invokeAction: params?.action })
    }

    return JSON.stringify({ status: 'error', error: `Unknown nodes action "${action}".` })
  } catch (err: any) {
    return JSON.stringify({ error: err.message })
  }
}

/**
 * Register as a Built-in Plugin
 */
const NodesPlugin: Plugin = {
  name: 'OpenClaw Nodes',
  description: 'Integrate with mobile apps and IoT devices via the OpenClaw gateway.',
  hooks: {} as PluginHooks,
  tools: [
    {
      name: 'openclaw_nodes',
      description: 'Interact with connected OpenClaw nodes/devices.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'notify', 'invoke'] },
          nodeId: { type: 'string' },
          message: { type: 'string' },
          params: { type: 'object' }
        },
        required: ['action']
      },
      execute: async (args) => executeNodesAction(args)
    }
  ]
}

getPluginManager().registerBuiltin('openclaw_nodes', NodesPlugin)

/**
 * Legacy Bridge
 */
export function buildOpenClawNodeTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('openclaw_nodes')) return []
  return [
    tool(
      async (args) => executeNodesAction(args),
      {
        name: 'openclaw_nodes',
        description: NodesPlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
