import type { Connector, Session } from '@/types'
import type { ConnectorInstance, InboundMessage } from './types'
import { hmrSingleton } from '@/lib/shared-utils'

export interface ConnectorReconnectState {
  attempts: number
  lastAttemptAt: number
  nextRetryAt: number
  backoffMs: number
  error: string
  exhausted: boolean
}

export interface ScheduledConnectorFollowup {
  id: string
  connectorId?: string
  platform?: string
  channelId: string
  sendAt: number
  timer: ReturnType<typeof setTimeout>
}

export interface DebouncedInboundEntry {
  connector: Connector
  messages: InboundMessage[]
  timer: ReturnType<typeof setTimeout>
}

export type RouteMessageHandler = (connector: Connector, msg: InboundMessage) => Promise<string>

export interface ConnectorRuntimeState {
  running: Map<string, ConnectorInstance>
  lastInboundChannelByConnector: Map<string, string>
  lastInboundTimeByConnector: Map<string, number>
  locks: Map<string, Promise<void>>
  generationCounter: Map<string, number>
  scheduledFollowups: Map<string, ScheduledConnectorFollowup>
  recentInboundByKey: Map<string, number>
  pendingInboundDebounce: Map<string, DebouncedInboundEntry>
  scheduledFollowupByDedupe: Map<string, { id: string; sendAt: number }>
  reconnectStates: Map<string, ConnectorReconnectState>
  recentOutbound: Map<string, number>
  routeMessageHandlerRef: { current: RouteMessageHandler }
}

export function getConnectorRuntimeState(): ConnectorRuntimeState {
  return hmrSingleton('__swarmclaw_connector_runtime_state__', () => ({
    running: hmrSingleton('__swarmclaw_running_connectors__', () => new Map<string, ConnectorInstance>()),
    lastInboundChannelByConnector: hmrSingleton('__swarmclaw_connector_last_inbound__', () => new Map<string, string>()),
    lastInboundTimeByConnector: hmrSingleton('__swarmclaw_connector_last_inbound_time__', () => new Map<string, number>()),
    locks: hmrSingleton('__swarmclaw_connector_locks__', () => new Map<string, Promise<void>>()),
    generationCounter: hmrSingleton('__swarmclaw_connector_gen__', () => new Map<string, number>()),
    scheduledFollowups: hmrSingleton('__swarmclaw_connector_followups__', () => new Map<string, ScheduledConnectorFollowup>()),
    recentInboundByKey: hmrSingleton('__swarmclaw_connector_inbound_dedupe__', () => new Map<string, number>()),
    pendingInboundDebounce: hmrSingleton('__swarmclaw_connector_inbound_debounce__', () => new Map<string, DebouncedInboundEntry>()),
    scheduledFollowupByDedupe: hmrSingleton('__swarmclaw_connector_followup_dedupe__', () => new Map<string, { id: string; sendAt: number }>()),
    reconnectStates: hmrSingleton('__swarmclaw_connector_reconnect_state__', () => new Map<string, ConnectorReconnectState>()),
    recentOutbound: hmrSingleton('__swarmclaw_connector_outbound_dedupe__', () => new Map<string, number>()),
    routeMessageHandlerRef: hmrSingleton('__swarmclaw_connector_route_handler__', () => ({
      current: async () => '[Error] Connector router unavailable.',
    })),
  }))
}

export const connectorRuntimeState = getConnectorRuntimeState()

export const runningConnectors = connectorRuntimeState.running

export type ConnectorThreadSession = Session
