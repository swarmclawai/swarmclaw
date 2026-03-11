import type { Agent, Session, MemoryEntry, Connector } from '@/types'
import { getMemoryDb } from '@/lib/server/memory/memory-db'
import { dedup } from '@/lib/shared-utils'
import { isReplyToLastOutbound, textMentionsAlias } from './policy'
import type { InboundMessage } from './types'

function toDigits(raw: string): string {
  const stripped = raw.replace(/@.*$/, '').replace(/[^\d]/g, '')
  if (stripped.startsWith('0') && stripped.length >= 10) return `44${stripped.slice(1)}`
  return stripped
}

function collectSenderIds(
  msg: InboundMessage,
  session?: Partial<Session> | null,
): string[] {
  return dedup([
    msg.senderId,
    msg.senderIdAlt,
    msg.channelId,
    msg.channelIdAlt,
    ...(Array.isArray(session?.connectorContext?.allKnownPeerIds) ? session.connectorContext.allKnownPeerIds : []),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0))
}

function memoryMatchesSender(entry: MemoryEntry, senderIds: string[], senderName: string): boolean {
  const title = String(entry.title || '').toLowerCase()
  const content = String(entry.content || '').toLowerCase()
  const normalizedSenderName = senderName.trim().toLowerCase()

  for (const rawId of senderIds) {
    const lowered = rawId.toLowerCase()
    if (lowered && (title.includes(lowered) || content.includes(lowered))) return true
  }

  const senderDigits = new Set(senderIds.map(toDigits).filter((value) => value.length >= 6))
  const memoryDigits = [
    ...(String(entry.content || '').match(/(?:\+?\d[\d\s\-().]{6,}\d)/g) || []).map(toDigits),
    ...(Array.isArray((entry.metadata as Record<string, unknown> | undefined)?.identifiers)
      ? ((entry.metadata as Record<string, unknown>).identifiers as unknown[])
        .filter((value): value is string => typeof value === 'string')
        .map(toDigits)
      : []),
  ].filter((value) => value.length >= 6)

  for (const memoryDigit of memoryDigits) {
    for (const senderDigit of senderDigits) {
      if (senderDigit.endsWith(memoryDigit) || memoryDigit.endsWith(senderDigit)) return true
    }
  }

  if (!normalizedSenderName) return false
  return title.includes(normalizedSenderName) || content.includes(normalizedSenderName)
}

function memoryDefinesQuietBoundary(entry: MemoryEntry): boolean {
  const text = `${entry.title || ''}\n${entry.content || ''}`.toLowerCase()
  const boundaryRule = /\b(?:do not respond|do not reply|don't respond|don't reply|no replies|stay quiet|stay silent|remain quiet|be quiet)\b[\s\S]{0,140}\bunless\b/i
  const directAddressRule = /\b(?:address(?:es|ed)?|mention(?:s|ed)?|refer(?:s|red)?|talk(?:ing)? to)\b[\s\S]{0,80}\bhal\b/i
  const verifyRule = /\bverify whether\b[\s\S]{0,80}\b(?:wayde|hal)\b/i
  return boundaryRule.test(text) && (directAddressRule.test(text) || verifyRule.test(text))
}

function buildDirectAddressAliases(agent: Partial<Agent> | null | undefined, connector: Partial<Connector> | null | undefined): string[] {
  const agentName = typeof agent?.name === 'string' ? agent.name.trim() : ''
  const connectorName = typeof connector?.name === 'string' ? connector.name.trim() : ''
  const aliases = [agentName, connectorName]
  const firstWord = agentName.split(/\s+/)[0] || ''
  if (firstWord) aliases.push(firstWord)
  if (agentName.toLowerCase().includes('hal')) aliases.push('Hal')
  return dedup(aliases.filter(Boolean))
}

export function enforceSenderQuietBoundary(params: {
  agent?: Partial<Agent> | null
  connector?: Partial<Connector> | null
  session?: Partial<Session> | null
  msg: InboundMessage
}): { suppress: boolean; memoryTitle?: string } {
  const { agent, connector, session, msg } = params
  if (!agent?.id || msg.isGroup) return { suppress: false }

  const senderIds = collectSenderIds(msg, session)
  const senderName = typeof msg.senderName === 'string' ? msg.senderName : ''
  if (senderIds.length === 0 && !senderName.trim()) return { suppress: false }

  const memDb = getMemoryDb()
  const memories = memDb.list(agent.id, 200).filter((entry) =>
    entry.category?.startsWith('identity/')
    && memoryMatchesSender(entry, senderIds, senderName),
  )
  const matchedBoundary = memories.find(memoryDefinesQuietBoundary)
  if (!matchedBoundary) return { suppress: false }

  const explicitlyAddressed = textMentionsAlias(msg.text || '', buildDirectAddressAliases(agent, connector))
    || isReplyToLastOutbound(msg, session)

  return explicitlyAddressed
    ? { suppress: false }
    : { suppress: true, memoryTitle: matchedBoundary.title }
}
