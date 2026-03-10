import type { Connector } from '@/types'
import { loadSettings } from '../storage'
import {
  createOrTouchPairingRequest,
  getWhatsAppApprovedSenderIds,
  isSenderAllowed,
  listStoredAllowedSenders,
  parseAllowFromCsv,
  parsePairingPolicy,
  type PairingPolicy,
} from './pairing'
import { isReplyToLastOutbound, resolveConnectorSessionPolicy, textMentionsAlias } from './policy'
import type { ConnectorAgent, ConnectorSession } from './session'
import type { InboundMessage } from './types'

export interface ResolvedPairingAccess {
  policy: PairingPolicy
  configAllowFrom: string[]
  isAllowed: boolean
  hasAnyApprover: boolean
}

export function evaluateGroupPolicy(params: {
  connector: Connector
  msg: InboundMessage
  session?: ConnectorSession | null
  aliases: string[]
}): { allowed: boolean; reason: string } {
  const { connector, msg, session, aliases } = params
  if (!msg.isGroup) return { allowed: true, reason: 'dm' }
  const policy = resolveConnectorSessionPolicy(connector, msg, session)
  if (policy.groupPolicy === 'open') return { allowed: true, reason: 'open' }
  if (policy.groupPolicy === 'disabled') return { allowed: false, reason: 'disabled' }
  const mentioned = !!msg.mentionsBot || textMentionsAlias(msg.text || '', aliases)
  const replied = isReplyToLastOutbound(msg, session)
  if (policy.groupPolicy === 'mention') {
    return { allowed: mentioned, reason: mentioned ? 'mentioned' : 'mention_required' }
  }
  const allowed = mentioned || replied
  return { allowed, reason: allowed ? (mentioned ? 'mentioned' : 'reply') : 'reply_or_mention_required' }
}

export function resolvePairingAccess(connector: Connector, msg: InboundMessage): ResolvedPairingAccess {
  const policy = parsePairingPolicy(connector.config?.dmPolicy, 'open')
  const globalWhatsAppAllowFrom = connector.platform === 'whatsapp'
    ? getWhatsAppApprovedSenderIds(loadSettings().whatsappApprovedContacts)
    : []
  const configAllowFrom = parseAllowFromCsv([
    connector.config?.allowFrom,
    ...globalWhatsAppAllowFrom,
  ].filter(Boolean).join(','))
  const stored = listStoredAllowedSenders(connector.id)
  const isAllowed = [
    msg.senderId,
    msg.senderIdAlt,
  ]
    .filter((senderId): senderId is string => typeof senderId === 'string' && !!senderId.trim())
    .some((senderId) => isSenderAllowed({
      connectorId: connector.id,
      senderId,
      configAllowFrom,
    }))
  return {
    policy,
    configAllowFrom,
    isAllowed,
    hasAnyApprover: (configAllowFrom.length + stored.length) > 0,
  }
}

export function resolveInboundApprovalSenderId(msg: InboundMessage): string {
  const alt = typeof msg.senderIdAlt === 'string' ? msg.senderIdAlt.trim() : ''
  if (alt) return alt
  return typeof msg.senderId === 'string' ? msg.senderId.trim() : ''
}

export function buildInboundApprovalSubject(msg: InboundMessage): string {
  const senderName = typeof msg.senderName === 'string' ? msg.senderName.trim() : ''
  const senderId = resolveInboundApprovalSenderId(msg)
  if (senderName && senderId && senderName !== senderId) return `${senderName} (${senderId})`
  return senderName || senderId || 'this sender'
}

export async function enforceInboundAccessPolicy(params: {
  connector: Connector
  msg: InboundMessage
  session: ConnectorSession
  agent: ConnectorAgent
  noMessageSentinel: string
}): Promise<string | null> {
  const { connector, msg, session, agent, noMessageSentinel } = params
  if (msg.isGroup) return null
  const { policy, isAllowed } = resolvePairingAccess(connector, msg)
  if (policy === 'open') return null

  if (policy === 'disabled') return noMessageSentinel
  if (isAllowed) return null

  const senderId = resolveInboundApprovalSenderId(msg)
  const senderSubject = buildInboundApprovalSubject(msg)

  if (policy === 'allowlist') {
    return [
      `${senderSubject} is not approved for this connector.`,
      'This connector is using allowlist mode, so no automatic approval queue is created.',
      'An approved operator can allow this sender in the app or via /pair allow <senderId>.',
    ].join('\n')
  }

  if (policy === 'pairing') {
    const request = createOrTouchPairingRequest({
      connectorId: connector.id,
      senderId,
      senderName: msg.senderName,
      channelId: msg.channelId,
    })
    return [
      `${senderSubject} is pending pairing for this connector.`,
      `Pairing code: ${request.code}`,
      'Approve in the app, or ask an approved sender to run /pair approve <code>.',
    ].join('\n')
  }

  return 'This sender is not authorized for this connector.'
}
