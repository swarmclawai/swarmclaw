import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { ToolBuildContext } from './context'

export function buildOpenClawNodeTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasTool('openclaw_nodes')) return []

  const tools: StructuredToolInterface[] = []

  tools.push(
    tool(
      async () => {
        try {
          const { listRunningConnectors } = await import('../connectors/manager')
          const openclawConnectors = listRunningConnectors('openclaw')
          if (!openclawConnectors.length) {
            return JSON.stringify({ error: 'No running OpenClaw connector found.' })
          }
          const { getRunningInstance } = await import('../connectors/manager')
          const inst = getRunningInstance(openclawConnectors[0].id)
          if (!inst) return JSON.stringify({ error: 'OpenClaw connector instance not accessible.' })

          // Proxy through RPC — use sendMessage as a workaround to invoke RPC
          // We need direct RPC access, so check if the instance exposes it
          // For now, return a helpful message about the integration
          return JSON.stringify({
            status: 'openclaw_nodes_list requires nodes.list RPC support on the gateway',
            connectorId: openclawConnectors[0].id,
            note: 'This feature requires the OpenClaw gateway to support nodes.* RPCs.',
          })
        } catch (err: any) {
          return JSON.stringify({ error: err.message })
        }
      },
      {
        name: 'openclaw_nodes_list',
        description: 'List connected nodes/IoT devices through the OpenClaw gateway. Requires a running OpenClaw connector with nodes.* RPC support.',
        schema: z.object({}),
      },
    ),
  )

  tools.push(
    tool(
      async ({ nodeId, action, params }) => {
        try {
          const { listRunningConnectors, getRunningInstance } = await import('../connectors/manager')
          const openclawConnectors = listRunningConnectors('openclaw')
          if (!openclawConnectors.length) {
            return JSON.stringify({ error: 'No running OpenClaw connector found.' })
          }
          const inst = getRunningInstance(openclawConnectors[0].id)
          if (!inst) return JSON.stringify({ error: 'OpenClaw connector instance not accessible.' })

          return JSON.stringify({
            status: 'openclaw_node_invoke requires nodes.invoke RPC support on the gateway',
            nodeId,
            action,
            params: params || null,
            connectorId: openclawConnectors[0].id,
          })
        } catch (err: any) {
          return JSON.stringify({ error: err.message })
        }
      },
      {
        name: 'openclaw_node_invoke',
        description: 'Invoke an action on a connected node/IoT device through the OpenClaw gateway.',
        schema: z.object({
          nodeId: z.string().describe('Target node ID'),
          action: z.string().describe('Action to invoke on the node'),
          params: z.record(z.string(), z.unknown()).optional().describe('Optional parameters for the action'),
        }),
      },
    ),
  )

  tools.push(
    tool(
      async ({ nodeId, message }) => {
        try {
          const { listRunningConnectors, getRunningInstance } = await import('../connectors/manager')
          const openclawConnectors = listRunningConnectors('openclaw')
          if (!openclawConnectors.length) {
            return JSON.stringify({ error: 'No running OpenClaw connector found.' })
          }
          const inst = getRunningInstance(openclawConnectors[0].id)
          if (!inst) return JSON.stringify({ error: 'OpenClaw connector instance not accessible.' })

          return JSON.stringify({
            status: 'openclaw_node_notify requires nodes.notify RPC support on the gateway',
            nodeId,
            message,
            connectorId: openclawConnectors[0].id,
          })
        } catch (err: any) {
          return JSON.stringify({ error: err.message })
        }
      },
      {
        name: 'openclaw_node_notify',
        description: 'Send a notification to a connected node/IoT device through the OpenClaw gateway.',
        schema: z.object({
          nodeId: z.string().describe('Target node ID'),
          message: z.string().describe('Notification message'),
        }),
      },
    ),
  )

  return tools
}
