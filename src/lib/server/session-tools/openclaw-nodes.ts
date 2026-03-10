import { z } from 'zod'
import { randomUUID } from 'crypto'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { ToolBuildContext } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { ensureGatewayConnected } from '../openclaw/gateway'

interface OpenClawNodesDeps {
  ensureGatewayConnected?: typeof ensureGatewayConnected
  generateId?: () => string
}

/**
 * Core OpenClaw Nodes Execution Logic
 */
export async function executeNodesAction(args: any, deps: OpenClawNodesDeps = {}) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const action = normalized.action as string | undefined
  const nodeId = (normalized.nodeId ?? normalized.node_id) as string | undefined
  const deviceId = (normalized.deviceId ?? normalized.device_id) as string | undefined
  const requestId = (normalized.requestId ?? normalized.request_id) as string | undefined
  const message = normalized.message as string | undefined
  const params = normalized.params as Record<string, unknown> | undefined
  const command = (normalized.command ?? params?.command ?? params?.action) as string | undefined
  const pairingType = typeof normalized.pairingType === 'string' ? normalized.pairingType : (typeof normalized.kind === 'string' ? normalized.kind : 'node')
  const profileId = (normalized.profileId ?? normalized.gatewayProfileId ?? normalized.gateway_profile_id) as string | undefined
  const agentId = (normalized.agentId ?? normalized.agent_id) as string | undefined
  const timeoutMs = typeof normalized.timeoutMs === 'number'
    ? normalized.timeoutMs
    : (typeof params?.timeoutMs === 'number' ? params.timeoutMs : undefined)
  const ensureGatewayConnectedFn = deps.ensureGatewayConnected ?? ensureGatewayConnected
  const generateId = deps.generateId ?? randomUUID
  try {
    const gateway = await ensureGatewayConnectedFn({ profileId, agentId })
    if (!gateway) {
      return JSON.stringify({
        status: 'not_connected',
        message: 'OpenClaw gateway not connected.',
        hint: 'Connect an OpenClaw gateway profile in Providers, then retry.',
      })
    }

    if (action === 'list') {
      const result = await gateway.rpc('node.list', { profileId })
      return JSON.stringify({ status: 'ok', action, result })
    }
    if (action === 'describe') {
      if (!nodeId) return JSON.stringify({ status: 'error', error: 'nodeId is required for describe.' })
      const result = await gateway.rpc('node.describe', { nodeId, profileId })
      return JSON.stringify({ status: 'ok', action, nodeId, result })
    }
    if (action === 'pairings') {
      const [nodePairings, devicePairings] = await Promise.all([
        gateway.rpc('node.pair.list', { profileId }),
        gateway.rpc('device.pair.list', { profileId }),
      ])
      return JSON.stringify({
        status: 'ok',
        action,
        result: {
          nodePairings,
          devicePairings,
        },
      })
    }
    if (action === 'approve_pairing') {
      if (!requestId) return JSON.stringify({ status: 'error', error: 'requestId is required for approve_pairing.' })
      const method = pairingType === 'device' ? 'device.pair.approve' : 'node.pair.approve'
      const result = await gateway.rpc(method, { requestId, profileId })
      return JSON.stringify({ status: 'ok', action, pairingType, requestId, result })
    }
    if (action === 'reject_pairing') {
      if (!requestId) return JSON.stringify({ status: 'error', error: 'requestId is required for reject_pairing.' })
      const method = pairingType === 'device' ? 'device.pair.reject' : 'node.pair.reject'
      const result = await gateway.rpc(method, { requestId, profileId })
      return JSON.stringify({ status: 'ok', action, pairingType, requestId, result })
    }
    if (action === 'remove_device') {
      if (!deviceId) return JSON.stringify({ status: 'error', error: 'deviceId is required for remove_device.' })
      const result = await gateway.rpc('device.pair.remove', { deviceId, profileId })
      return JSON.stringify({ status: 'ok', action, deviceId, result })
    }
    if (action === 'notify' || action === 'invoke') {
      if (!nodeId) return JSON.stringify({ status: 'error', error: 'nodeId is required for invoke.' })
      const invokeCommand = typeof command === 'string' && command.trim()
        ? command.trim()
        : (action === 'notify' ? 'notify' : '')
      if (!invokeCommand) return JSON.stringify({ status: 'error', error: 'command is required for invoke.' })
      const invokeParams = action === 'notify'
        ? { ...(params || {}), message }
        : (params || {})
      const result = await gateway.rpc('node.invoke', {
        nodeId,
        command: invokeCommand,
        params: invokeParams,
        timeoutMs,
        idempotencyKey: generateId(),
        profileId,
      })
      return JSON.stringify({ status: 'ok', action, nodeId, command: invokeCommand, result })
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
          action: { type: 'string', enum: ['list', 'describe', 'pairings', 'approve_pairing', 'reject_pairing', 'remove_device', 'notify', 'invoke'] },
          nodeId: { type: 'string' },
          deviceId: { type: 'string' },
          requestId: { type: 'string' },
          pairingType: { type: 'string', enum: ['node', 'device'] },
          profileId: { type: 'string' },
          agentId: { type: 'string' },
          command: { type: 'string' },
          message: { type: 'string' },
          params: { type: 'object' },
          timeoutMs: { type: 'number' },
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
