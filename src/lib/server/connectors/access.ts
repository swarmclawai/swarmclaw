import type {
  Connector,
  ConnectorDmAddressingMode,
  ConnectorAccessSenderStatus,
  ConnectorAccessSnapshot,
  WhatsAppApprovedContact,
} from '@/types'
import { loadSettings } from '../storage'
import {
  createOrTouchPairingRequest,
  getSenderAddressingOverride,
  isSenderAllowed,
  listSenderAddressingOverrides,
  listPendingPairingRequests,
  listStoredAllowedSenders,
  normalizeWhatsAppApprovedContacts,
  parseAllowFromCsv,
  parseDmAddressingMode,
  parsePairingPolicy,
  senderMatchesAnyEntry,
  type PairingPolicy,
} from './pairing'
import { isReplyToLastOutbound, resolveConnectorSessionPolicy, textMentionsAlias } from './policy'
import type { InboundMessage } from './types'

export interface ResolvedPairingAccess {
  policy: PairingPolicy
  configAllowFrom: string[]
  configDenyFrom: string[]
  globalWhatsAppAllowFrom: string[]
  storedAllowFrom: string[]
  isAllowed: boolean
  isDenied: boolean
  isOwnerConversation: boolean
  hasAnyApprover: boolean
}

interface ResolvedDmAddressing {
  dmAddressingMode: ConnectorDmAddressingMode
  senderDmAddressingOverride: ConnectorDmAddressingMode | null
  effectiveDmAddressingMode: ConnectorDmAddressingMode
  requiresDirectAddress: boolean
}

function collectSenderIds(params: {
  senderId?: string | null
  senderIdAlt?: string | null
}): string[] {
  return [params.senderId, params.senderIdAlt]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
}

function resolveGlobalWhatsAppApprovedContacts(connector: Connector): WhatsAppApprovedContact[] {
  if (connector.platform !== 'whatsapp') return []
  return normalizeWhatsAppApprovedContacts(loadSettings().whatsappApprovedContacts)
}

export function resolveConnectorDmAddressingMode(connector: Connector): ConnectorDmAddressingMode {
  return parseDmAddressingMode(connector.config?.dmAddressingMode, 'open')
}

export function buildConnectorAddressAliases(params: {
  agentName?: string | null
  connectorName?: string | null
  aliases?: string[]
}): string[] {
  const variants = new Set<string>()
  for (const raw of [params.agentName, params.connectorName, ...(params.aliases || [])]) {
    const trimmed = typeof raw === 'string' ? raw.trim() : ''
    if (!trimmed) continue
    variants.add(trimmed)
    const firstWord = trimmed.split(/\s+/)[0]?.trim()
    if (firstWord) variants.add(firstWord)
    if (trimmed.toLowerCase().includes('hal')) variants.add('Hal')
  }
  return [...variants]
}

export function resolveConnectorOwnerSenderId(connector: Connector): string | null {
  const ownerSenderId = typeof connector.config?.ownerSenderId === 'string'
    ? connector.config.ownerSenderId.trim()
    : ''
  return ownerSenderId || null
}

export function isConfiguredOwnerConversation(
  connector: Connector,
  msgOrSender: Pick<InboundMessage, 'senderId' | 'senderIdAlt' | 'isOwnerConversation'> | { senderId?: string | null; senderIdAlt?: string | null },
): boolean {
  const ownerSenderId = resolveConnectorOwnerSenderId(connector)
  if (!ownerSenderId) {
    return 'isOwnerConversation' in msgOrSender ? msgOrSender.isOwnerConversation === true : false
  }
  const candidateIds = collectSenderIds(msgOrSender)
  if (senderMatchesAnyEntry(candidateIds, [ownerSenderId])) return true
  return 'isOwnerConversation' in msgOrSender ? msgOrSender.isOwnerConversation === true : false
}

export function isConfiguredDeniedSender(
  connector: Connector,
  params: { senderId?: string | null; senderIdAlt?: string | null },
): boolean {
  const denyFrom = parseAllowFromCsv(connector.config?.denyFrom)
  if (!denyFrom.length) return false
  const candidateIds = collectSenderIds(params)
  return senderMatchesAnyEntry(candidateIds, denyFrom)
}

export function applyConnectorAccessMetadata(connector: Connector, msg: InboundMessage): InboundMessage {
  const isOwnerConversation = isConfiguredOwnerConversation(connector, msg)
  if (msg.isOwnerConversation === isOwnerConversation) return msg
  return {
    ...msg,
    isOwnerConversation,
  }
}

export function evaluateGroupPolicy(params: {
  connector: Connector
  msg: InboundMessage
  session?: { connectorContext?: { lastOutboundAt?: number | null; lastOutboundMessageId?: string | null } } | null
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
  const globalWhatsAppAllowFrom = resolveGlobalWhatsAppApprovedContacts(connector).map((entry) => entry.phone)
  const configAllowFrom = parseAllowFromCsv([
    connector.config?.allowFrom,
    ...globalWhatsAppAllowFrom,
  ].filter(Boolean).join(','))
  const configDenyFrom = parseAllowFromCsv(connector.config?.denyFrom)
  const storedAllowFrom = listStoredAllowedSenders(connector.id)
  const candidateIds = collectSenderIds(msg)
  const isOwnerConversation = isConfiguredOwnerConversation(connector, msg)
  const isDenied = !isOwnerConversation && senderMatchesAnyEntry(candidateIds, configDenyFrom)
  const isAllowed = isOwnerConversation || candidateIds.some((senderId) => isSenderAllowed({
    connectorId: connector.id,
    senderId,
    configAllowFrom,
  }))
  return {
    policy,
    configAllowFrom,
    configDenyFrom,
    globalWhatsAppAllowFrom,
    storedAllowFrom,
    isAllowed,
    isDenied,
    isOwnerConversation,
    hasAnyApprover: (configAllowFrom.length + storedAllowFrom.length) > 0,
  }
}

export function resolveDmAddressingAccess(
  connector: Connector,
  msg: Pick<InboundMessage, 'senderId' | 'senderIdAlt' | 'isOwnerConversation'>,
): ResolvedDmAddressing {
  const dmAddressingMode = resolveConnectorDmAddressingMode(connector)
  const senderIds = collectSenderIds(msg)
  const senderDmAddressingOverride = getSenderAddressingOverride(connector.id, senderIds)
  const effectiveDmAddressingMode = senderDmAddressingOverride || dmAddressingMode
  return {
    dmAddressingMode,
    senderDmAddressingOverride,
    effectiveDmAddressingMode,
    requiresDirectAddress: msg.isOwnerConversation !== true && effectiveDmAddressingMode === 'addressed',
  }
}

function isMessageExplicitlyAddressed(params: {
  msg: InboundMessage
  session?: { connectorContext?: { lastOutboundMessageId?: string | null } } | null
  aliases?: string[]
}): boolean {
  if (params.msg.mentionsBot) return true
  if (isReplyToLastOutbound(params.msg, params.session)) return true
  const aliases = Array.isArray(params.aliases) ? params.aliases : []
  return aliases.length > 0 ? textMentionsAlias(params.msg.text || '', aliases) : false
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
  noMessageSentinel: string
  session?: { connectorContext?: { lastOutboundMessageId?: string | null } } | null
  aliases?: string[]
}): Promise<string | null> {
  const { connector, msg, noMessageSentinel } = params
  if (msg.isGroup) return null
  const access = resolvePairingAccess(connector, msg)
  if (access.isOwnerConversation) return null

  const senderSubject = buildInboundApprovalSubject(msg)
  if (access.isDenied) {
    return [
      `${senderSubject} is blocked for this connector.`,
      'This sender is on the connector deny list, so their messages are ignored before approval or pairing checks.',
      'Remove them from the deny list in Inbox or Connector settings to restore access.',
    ].join('\n')
  }

  const dmAddressing = resolveDmAddressingAccess(connector, msg)
  if (dmAddressing.requiresDirectAddress && !isMessageExplicitlyAddressed({
    msg,
    session: params.session,
    aliases: params.aliases,
  })) {
    return noMessageSentinel
  }

  if (access.policy === 'open') return null
  if (access.policy === 'disabled') return noMessageSentinel
  if (access.isAllowed) return null

  const senderId = resolveInboundApprovalSenderId(msg)

  if (access.policy === 'allowlist') {
    return [
      `${senderSubject} is not approved for this connector.`,
      'This connector is using allowlist mode, so no automatic approval queue is created.',
      'An approved operator can allow this sender in the app or via /pair allow <senderId>.',
    ].join('\n')
  }

  if (access.policy === 'pairing') {
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

export function buildConnectorAccessSnapshot(params: {
  connector: Connector
  senderId?: string | null
  senderIdAlt?: string | null
}): ConnectorAccessSnapshot {
  const { connector, senderId, senderIdAlt } = params
  const globalWhatsAppApprovedContacts = resolveGlobalWhatsAppApprovedContacts(connector)
  const allowFrom = parseAllowFromCsv(connector.config?.allowFrom)
  const denyFrom = parseAllowFromCsv(connector.config?.denyFrom)
  const storedAllowedSenderIds = listStoredAllowedSenders(connector.id)
  const senderAddressingOverrides = listSenderAddressingOverrides(connector.id)
  const pendingPairingRequests = listPendingPairingRequests(connector.id)
  const ownerSenderId = resolveConnectorOwnerSenderId(connector)
  const dmAddressingMode = resolveConnectorDmAddressingMode(connector)
  const senderIds = collectSenderIds({ senderId, senderIdAlt })

  let senderStatus: ConnectorAccessSenderStatus | null = null
  if (senderIds.length > 0) {
    const isOwnerOverride = !!ownerSenderId && senderMatchesAnyEntry(senderIds, [ownerSenderId])
    const isConfigAllowed = senderMatchesAnyEntry(senderIds, allowFrom)
    const isStoredAllowed = senderMatchesAnyEntry(senderIds, storedAllowedSenderIds)
    const isGlobalAllowed = senderMatchesAnyEntry(senderIds, globalWhatsAppApprovedContacts.map((entry) => entry.phone))
    const isBlocked = senderMatchesAnyEntry(senderIds, denyFrom)
    const pending = pendingPairingRequests.find((entry) => senderMatchesAnyEntry(senderIds, [entry.senderId])) || null
    const dmAddressingOverride = getSenderAddressingOverride(connector.id, senderIds)
    const effectiveDmAddressingMode = dmAddressingOverride || dmAddressingMode
    senderStatus = {
      senderIds,
      isOwnerOverride,
      isBlocked,
      isApproved: isOwnerOverride || isConfigAllowed || isStoredAllowed || isGlobalAllowed,
      isConfigAllowed,
      isStoredAllowed,
      isGlobalAllowed,
      isPending: !!pending,
      pendingCode: pending?.code || null,
      dmAddressingOverride,
      effectiveDmAddressingMode,
      requiresDirectAddress: effectiveDmAddressingMode === 'addressed',
    }
  }

  return {
    connectorId: connector.id,
    platform: connector.platform,
    dmPolicy: parsePairingPolicy(connector.config?.dmPolicy, 'open'),
    dmAddressingMode,
    allowFrom,
    denyFrom,
    ownerSenderId,
    storedAllowedSenderIds,
    senderAddressingOverrides,
    pendingPairingRequests,
    globalWhatsAppApprovedContacts,
    senderStatus,
  }
}
