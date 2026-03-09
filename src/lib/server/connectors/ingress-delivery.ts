import { isNoMessage } from './message-sentinel'
import { normalizeConnectorIngressResult, type ConnectorIngressResult, type ConnectorRouteResult, type InboundMessage } from './types'

export interface ConnectorIngressReply {
  routeResult: ConnectorRouteResult
  visibleText: string
}

export async function resolveConnectorIngressReply(
  onMessage: (msg: InboundMessage) => Promise<ConnectorIngressResult>,
  inbound: InboundMessage,
): Promise<ConnectorIngressReply | null> {
  const routeResult = normalizeConnectorIngressResult(await onMessage(inbound))
  if (routeResult.managerHandled || routeResult.delivery === 'silent') return null

  const visibleText = routeResult.visibleText
  if (!visibleText || isNoMessage(visibleText)) return null

  return {
    routeResult,
    visibleText,
  }
}
