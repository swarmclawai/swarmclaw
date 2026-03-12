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

function normalizeFreeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function extractMemoryLabels(entry: MemoryEntry): string[] {
  const content = String(entry.content || '').trim()
  const firstLine = content.split('\n', 1)[0]?.trim() || ''
  const prefix = firstLine.includes(':') ? firstLine.split(':', 1)[0]?.trim() || '' : firstLine
  return dedup([
    String(entry.title || '').trim(),
    prefix,
  ].filter((value) => value.length > 0))
}

function labelMatchesSenderName(label: string, senderName: string): boolean {
  const normalizedLabel = normalizeFreeText(label)
  const normalizedSenderName = normalizeFreeText(senderName)
  if (!normalizedLabel || !normalizedSenderName) return false
  if (normalizedLabel === normalizedSenderName) return true
  if (!normalizedLabel.startsWith(normalizedSenderName)) return false
  const suffix = normalizedLabel.slice(normalizedSenderName.length).trim()
  if (!suffix) return true
  return /^[\s,.:;()+\-_/0-9@]+$/.test(suffix)
}

function extractExplicitMemoryIdentifiers(entry: MemoryEntry): string[] {
  const metadata = entry.metadata as Record<string, unknown> | undefined
  const metadataIdentifiers = Array.isArray(metadata?.identifiers)
    ? metadata.identifiers.filter((value): value is string => typeof value === 'string')
    : []
  const text = `${entry.title || ''}\n${entry.content || ''}`
  const jidLikeIdentifiers = text.match(/[0-9a-z_.:+-]+@[0-9a-z_.:-]+/gi) || []
  return dedup([
    ...metadataIdentifiers,
    ...jidLikeIdentifiers,
  ].map((value) => value.trim().toLowerCase()).filter(Boolean))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function memoryMatchesSender(entry: MemoryEntry, senderIds: string[], senderName: string): boolean {
  const title = String(entry.title || '').toLowerCase()
  const content = String(entry.content || '').toLowerCase()
  const normalizedSenderName = normalizeFreeText(senderName)

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
  const explicitMemoryIdentifiers = extractExplicitMemoryIdentifiers(entry)

  for (const memoryDigit of memoryDigits) {
    for (const senderDigit of senderDigits) {
      if (senderDigit.endsWith(memoryDigit) || memoryDigit.endsWith(senderDigit)) return true
    }
  }

  if (explicitMemoryIdentifiers.length > 0 || memoryDigits.length > 0) {
    return false
  }

  if (!normalizedSenderName) return false
  return extractMemoryLabels(entry).some((label) => labelMatchesSenderName(label, normalizedSenderName))
}

function memoryDefinesQuietBoundary(
  entry: MemoryEntry,
  aliases: string[],
): boolean {
  const metadata = entry.metadata as Record<string, unknown> | undefined
  if (metadata?.boundaryType === 'quiet_until_directly_addressed') return true
  if (metadata?.directAddressRequired === true && metadata?.suppressReplies === true) return true

  const text = `${entry.title || ''}\n${entry.content || ''}`.toLowerCase()
  const boundaryRule = /\b(?:do not respond|do not reply|don't respond|don't reply|no replies|stay quiet|stay silent|remain quiet|be quiet)\b[\s\S]{0,140}\bunless\b/i
  const aliasPattern = dedup(aliases.map((alias) => normalizeFreeText(alias)).filter(Boolean))
    .map((alias) => escapeRegExp(alias))
    .join('|')
  const aliasTargetRule = aliasPattern
    ? new RegExp(`\\b(?:address(?:es|ed)?|mention(?:s|ed)?|refer(?:s|red)?|talk(?:ing)? to)\\b[\\s\\S]{0,80}\\b(?:${aliasPattern})\\b`, 'i')
    : null
  const genericTargetRule = /\b(?:address(?:es|ed)?|mention(?:s|ed)?|refer(?:s|red)?|talk(?:ing)? to)\b[\s\S]{0,80}\b(?:you|the agent|assistant|bot)\b/i
  const verifyRule = /\bverify whether\b[\s\S]{0,120}\b(?:message|reply|response|it)\b[\s\S]{0,80}\b(?:is for|is meant for|was intended for|is addressed to)\b[\s\S]{0,80}\b(?:you|the agent|assistant|bot)\b/i
  const directAddressRule = (aliasTargetRule ? aliasTargetRule.test(text) : false) || genericTargetRule.test(text)
  return boundaryRule.test(text) && (directAddressRule || verifyRule.test(text))
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
  if (!agent?.id) return { suppress: false }

  const senderIds = collectSenderIds(msg, session)
  const senderName = typeof msg.senderName === 'string' ? msg.senderName : ''
  if (senderIds.length === 0 && !senderName.trim()) return { suppress: false }

  const memDb = getMemoryDb()
  const aliases = buildDirectAddressAliases(agent, connector)
  const memories = memDb.list(agent.id, 200).filter((entry) =>
    entry.category?.startsWith('identity/')
    && memoryMatchesSender(entry, senderIds, senderName),
  )
  const matchedBoundary = memories.find((entry) => memoryDefinesQuietBoundary(entry, aliases))
  if (!matchedBoundary) return { suppress: false }

  const explicitlyAddressed = textMentionsAlias(msg.text || '', aliases)
    || isReplyToLastOutbound(msg, session)

  if (explicitlyAddressed) return { suppress: false }

  // Groups: soft-suppress via prompt injection (agent keeps context but self-enforces silence)
  // DMs: hard-suppress at routing level (no LLM call needed)
  return msg.isGroup
    ? { suppress: false, memoryTitle: matchedBoundary.title }
    : { suppress: true, memoryTitle: matchedBoundary.title }
}

/**
 * Load sender-specific boundary context for prompt injection.
 * Returns a formatted prompt block if boundary memories exist for the sender, '' otherwise.
 */
export function loadSenderBoundaryContext(params: {
  agent?: Partial<Agent> | null
  connector?: Partial<Connector> | null
  session?: Partial<Session> | null
  msg: InboundMessage
}): string {
  const { agent, connector, session, msg } = params
  if (!agent?.id) return ''

  const senderIds = collectSenderIds(msg, session)
  const senderName = typeof msg.senderName === 'string' ? msg.senderName : ''
  if (senderIds.length === 0 && !senderName.trim()) return ''

  const memDb = getMemoryDb()
  const aliases = buildDirectAddressAliases(agent, connector)
  const memories = memDb.list(agent.id, 200).filter((entry) =>
    entry.category?.startsWith('identity/')
    && memoryMatchesSender(entry, senderIds, senderName),
  )
  if (memories.length === 0) return ''

  const capped = memories.slice(0, 5)
  const hasBoundary = capped.some((entry) => memoryDefinesQuietBoundary(entry, aliases))
  const displayName = senderName || msg.senderId

  const lines = ['## Contact-Specific Preferences', `The following stored preferences apply to the current sender "${displayName}":`]
  for (const entry of capped) {
    const summary = String(entry.content || '').slice(0, 500).split('\n')[0] || ''
    lines.push(`- ${entry.title || 'Untitled'}: ${summary}`)
  }

  if (hasBoundary) {
    lines.push('')
    lines.push(`IMPORTANT: You have a stored boundary for ${displayName}. Do NOT respond to their messages unless they directly address you by name or reply to one of your messages. If this message is not directed at you, respond with exactly "NO_MESSAGE".`)
  }

  return lines.join('\n')
}
