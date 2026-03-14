import type { Agent, MemoryEntry, Session } from '@/types'
import { dedup } from '@/lib/shared-utils'
import { getMemoryDb } from '@/lib/server/memory/memory-db'
import type { InboundMessage } from './types'

const SENDER_PREFERENCE_CATEGORIES = new Set([
  'identity/preferences',
  'identity/contacts',
  'identity/relationships',
])

function summaryForPrompt(entry: MemoryEntry): string {
  const title = String(entry.title || '').trim()
  const firstLine = String(entry.content || '').split('\n').find((line) => line.trim())?.trim() || ''
  const summary = [title, firstLine].filter(Boolean).join(': ')
  if (!summary) return ''
  return summary.length > 220 ? `${summary.slice(0, 217)}...` : summary
}

function connectorPreferenceMetadata(entry: MemoryEntry): Record<string, unknown> | null {
  const metadata = entry.metadata as Record<string, unknown> | undefined
  const direct = metadata?.connectorPreference
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>
  }
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : null
}

function preferredDisplayNameFromMetadata(entry: MemoryEntry): string | null {
  const metadata = connectorPreferenceMetadata(entry)
  const value = typeof metadata?.preferredDisplayName === 'string' ? metadata.preferredDisplayName.trim() : ''
  return value || null
}

function preferredReplyMediumFromMetadata(entry: MemoryEntry): 'voice_note' | null {
  const metadata = connectorPreferenceMetadata(entry)
  return metadata?.preferredReplyMedium === 'voice_note' ? 'voice_note' : null
}

function listSenderPreferenceMemories(params: {
  agent?: Partial<Agent> | null
  session?: Partial<Session> | null
}): MemoryEntry[] {
  const agentId = typeof params.agent?.id === 'string' ? params.agent.id.trim() : ''
  const sessionId = typeof params.session?.id === 'string' ? params.session.id.trim() : ''
  if (!agentId || !sessionId) return []
  const memDb = getMemoryDb()
  return memDb.list(agentId, 250)
    .filter((entry) => entry.sessionId === sessionId)
    .filter((entry) => SENDER_PREFERENCE_CATEGORIES.has(String(entry.category || '').trim()))
    .sort((a, b) => (a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0))
}

export interface ResolvedSenderPreferencePolicy {
  preferredDisplayName: string | null
  preferredReplyMedium: 'voice_note' | null
  styleInstructions: string[]
}

export function resolveSenderPreferencePolicy(params: {
  agent?: Partial<Agent> | null
  session?: Partial<Session> | null
  msg: InboundMessage
}): ResolvedSenderPreferencePolicy {
  if (params.msg.isGroup) {
    return {
      preferredDisplayName: null,
      preferredReplyMedium: null,
      styleInstructions: [],
    }
  }

  const memories = listSenderPreferenceMemories(params)
  let preferredDisplayName: string | null = null
  let preferredReplyMedium: 'voice_note' | null = null
  const styleInstructions: string[] = []

  for (const entry of memories) {
    const displayName = preferredDisplayNameFromMetadata(entry)
    if (displayName) preferredDisplayName = displayName

    const replyMedium = preferredReplyMediumFromMetadata(entry)
    if (replyMedium) preferredReplyMedium = replyMedium

    const summary = summaryForPrompt(entry)
    if (summary) styleInstructions.push(summary)
  }

  return {
    preferredDisplayName,
    preferredReplyMedium,
    styleInstructions: dedup(styleInstructions).slice(-4),
  }
}

export function buildSenderPreferenceContextBlock(
  policy: ResolvedSenderPreferencePolicy,
  senderLabel: string,
): string {
  const lines: string[] = []
  if (policy.preferredDisplayName) {
    lines.push(`- Address this sender as "${policy.preferredDisplayName}".`)
  }
  if (policy.preferredReplyMedium === 'voice_note') {
    lines.push('- Reply with a voice note in this direct chat unless one has already been sent this turn.')
  }
  for (const instruction of policy.styleInstructions) {
    lines.push(`- ${instruction}`)
  }
  if (lines.length === 0) return ''
  return [
    '## Sender Preferences',
    `These stored preferences apply to the current sender "${senderLabel}":`,
    ...lines,
  ].join('\n')
}
