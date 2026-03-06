import type { Connector } from '@/types'
import { buildConnectorDoctorWarnings, resolveConnectorSessionPolicy } from './policy'
import type { InboundMessage } from './types'

export interface ConnectorDoctorPreviewInput {
  id?: unknown
  name?: unknown
  platform?: unknown
  agentId?: unknown
  chatroomId?: unknown
  credentialId?: unknown
  config?: unknown
  sampleMsg?: Partial<InboundMessage> | null
}

function sanitizeConfig(raw: unknown, fallback: Record<string, string>): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...fallback }
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || value === undefined) continue
    next[key] = typeof value === 'string' ? value : String(value)
  }
  return next
}

function normalizeNullableText(value: unknown, fallback: string | null = null): string | null {
  if (value === null) return null
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed || null
}

function buildSampleMessage(connector: Connector, sampleMsg?: Partial<InboundMessage> | null): InboundMessage {
  return {
    platform: connector.platform,
    channelId: typeof sampleMsg?.channelId === 'string' && sampleMsg.channelId.trim()
      ? sampleMsg.channelId.trim()
      : 'sample-channel',
    channelName: typeof sampleMsg?.channelName === 'string' && sampleMsg.channelName.trim()
      ? sampleMsg.channelName.trim()
      : 'sample-channel',
    senderId: typeof sampleMsg?.senderId === 'string' && sampleMsg.senderId.trim()
      ? sampleMsg.senderId.trim()
      : 'sample-user',
    senderName: typeof sampleMsg?.senderName === 'string' && sampleMsg.senderName.trim()
      ? sampleMsg.senderName.trim()
      : 'Sample User',
    text: typeof sampleMsg?.text === 'string' && sampleMsg.text.trim()
      ? sampleMsg.text.trim()
      : 'sample',
    isGroup: sampleMsg?.isGroup === true,
    messageId: typeof sampleMsg?.messageId === 'string' && sampleMsg.messageId.trim()
      ? sampleMsg.messageId.trim()
      : undefined,
    replyToMessageId: typeof sampleMsg?.replyToMessageId === 'string' && sampleMsg.replyToMessageId.trim()
      ? sampleMsg.replyToMessageId.trim()
      : undefined,
    threadId: typeof sampleMsg?.threadId === 'string' && sampleMsg.threadId.trim()
      ? sampleMsg.threadId.trim()
      : undefined,
  }
}

export function buildConnectorDoctorPreview(params: {
  input?: ConnectorDoctorPreviewInput | null
  baseConnector?: Connector | null
  fallbackId?: string
}): Connector {
  const { input, baseConnector, fallbackId = 'connector-preview' } = params
  const now = Date.now()
  return {
    id: baseConnector?.id || fallbackId,
    name: normalizeNullableText(input?.name, baseConnector?.name || 'Connector Preview') || 'Connector Preview',
    platform: normalizeNullableText(input?.platform, baseConnector?.platform || 'discord') as Connector['platform'],
    agentId: input?.agentId === undefined
      ? (baseConnector?.agentId ?? null)
      : normalizeNullableText(input.agentId, null),
    chatroomId: input?.chatroomId === undefined
      ? (baseConnector?.chatroomId ?? null)
      : normalizeNullableText(input.chatroomId, null),
    credentialId: input?.credentialId === undefined
      ? (baseConnector?.credentialId ?? null)
      : normalizeNullableText(input.credentialId, null),
    config: input?.config === undefined
      ? { ...(baseConnector?.config || {}) }
      : sanitizeConfig(input.config, baseConnector?.config || {}),
    isEnabled: baseConnector?.isEnabled ?? true,
    status: baseConnector?.status ?? 'stopped',
    createdAt: baseConnector?.createdAt ?? now,
    updatedAt: now,
  }
}

export function buildConnectorDoctorReport(
  connector: Connector,
  sampleMsg?: Partial<InboundMessage> | null,
  opts?: { baseConnector?: Connector | null },
): {
  warnings: string[]
  policy: ReturnType<typeof resolveConnectorSessionPolicy>
} {
  const msg = buildSampleMessage(connector, sampleMsg)
  const warnings = buildConnectorDoctorWarnings({ connector, msg })
  const baseConnector = opts?.baseConnector
  if (baseConnector) {
    if (baseConnector.status === 'error') {
      warnings.push('Connector is currently in an error state. Review the health timeline and credentials before expecting autonomy to run.')
    } else if (baseConnector.isEnabled !== false && baseConnector.status !== 'running') {
      warnings.push('Connector is not currently connected, so inbound autonomy will not run until it is started.')
    }
  }
  return {
    warnings,
    policy: resolveConnectorSessionPolicy(connector, msg),
  }
}
