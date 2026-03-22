import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { Agent, MemoryEntry, MemoryReference, Message, Session } from '@/types'
import { getMemoryDb } from '@/lib/server/memory/memory-db'
import { loadAgents, loadSessions, saveSessions } from '@/lib/server/storage'
import { DATA_DIR } from '@/lib/server/data-dir'
import { isDirectConnectorSession } from '@/lib/server/connectors/session-kind'
import { getMessageCount, getRecentMessages } from '@/lib/server/messages/message-repository'

const MAX_ARCHIVE_MESSAGES = 36
const MAX_ARCHIVE_LINE_CHARS = 320
const SESSION_ARCHIVE_EXPORT_DIR = path.join(DATA_DIR, 'session-archives')

function toOneLine(value: unknown, maxChars: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

function messageSpeaker(session: Session, agent: Partial<Agent> | null | undefined, message: Message): string {
  if (message.role === 'assistant') return agent?.name || 'assistant'
  return (isDirectConnectorSession(session) ? session.connectorContext?.senderName : null) || session.user || 'user'
}

function slugifySegment(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || fallback
}

export function buildSessionArchivePayload(
  session: Session,
  agent?: Partial<Agent> | null,
): {
  title: string
  content: string
  metadata: Record<string, unknown>
  references: MemoryReference[]
  hash: string
} | null {
  const messageCount = getMessageCount(session.id)
  if (messageCount < 2) return null

  const excerpt = getRecentMessages(session.id, MAX_ARCHIVE_MESSAGES).map((message) => {
    const speaker = messageSpeaker(session, agent, message)
    const kind = message.kind && message.kind !== 'chat' ? ` [${message.kind}]` : ''
    const text = toOneLine(message.text, MAX_ARCHIVE_LINE_CHARS)
    const tools = Array.isArray(message.toolEvents) && message.toolEvents.length > 0
      ? ` | tools=${message.toolEvents.map((event) => event.name).join(',')}`
      : ''
    return `- ${speaker}${kind}: ${text}${tools}`
  }).join('\n')

  const title = `Session archive: ${session.name || session.id}`
  const content = [
    `session_id: ${session.id}`,
    `session_name: ${toOneLine(session.name, 160)}`,
    `session_type: ${toOneLine(session.sessionType || 'human', 32)}`,
    `agent_name: ${toOneLine(agent?.name || '', 80)}`,
    `last_active_iso: ${new Date(session.lastActiveAt || Date.now()).toISOString()}`,
    `message_count: ${messageCount}`,
    session.identityState?.personaLabel ? `persona_label: ${toOneLine(session.identityState.personaLabel, 120)}` : '',
    '',
    'Transcript excerpt:',
    excerpt,
  ].filter(Boolean).join('\n')

  const hash = createHash('sha256').update(`${title}\n${content}`).digest('hex').slice(0, 16)
  return {
    title,
    content,
    metadata: {
      tier: 'archive',
      archiveHash: hash,
      sessionName: session.name,
      sessionType: session.sessionType || 'human',
      messageCount,
      lastActiveAt: session.lastActiveAt || Date.now(),
      personaLabel: session.identityState?.personaLabel || null,
    },
    references: [{
      type: 'session',
      path: session.id,
      title: session.name,
      note: 'Searchable session archive snapshot',
      timestamp: Date.now(),
    }],
    hash,
  }
}

export function buildSessionArchiveMarkdown(
  session: Session,
  payload: NonNullable<ReturnType<typeof buildSessionArchivePayload>>,
  agent?: Partial<Agent> | null,
): string {
  const transcriptLines = getRecentMessages(session.id, MAX_ARCHIVE_MESSAGES).map((message) => {
    const speaker = messageSpeaker(session, agent, message)
    const kind = message.kind && message.kind !== 'chat' ? ` (${message.kind})` : ''
    const toolSummary = Array.isArray(message.toolEvents) && message.toolEvents.length > 0
      ? ` [tools: ${message.toolEvents.map((event) => event.name).join(', ')}]`
      : ''
    return `- **${speaker}**${kind}: ${toOneLine(message.text, MAX_ARCHIVE_LINE_CHARS)}${toolSummary}`
  })

  return [
    `# ${payload.title}`,
    '',
    `- Session ID: ${session.id}`,
    `- Session Name: ${toOneLine(session.name, 160)}`,
    `- Session Type: ${toOneLine(session.sessionType || 'human', 32)}`,
    `- Agent: ${toOneLine(agent?.name || session.agentId || 'unknown', 80)}`,
    `- Last Active: ${new Date(session.lastActiveAt || Date.now()).toISOString()}`,
    `- Messages: ${getMessageCount(session.id)}`,
    session.identityState?.personaLabel ? `- Persona: ${toOneLine(session.identityState.personaLabel, 120)}` : '',
    '',
    '## Archive Snapshot',
    '',
    '```text',
    payload.content,
    '```',
    '',
    '## Transcript Excerpt',
    '',
    ...transcriptLines,
    '',
  ].filter(Boolean).join('\n')
}

function exportSessionArchiveMarkdown(
  session: Session,
  payload: NonNullable<ReturnType<typeof buildSessionArchivePayload>>,
  agent?: Partial<Agent> | null,
): string | null {
  try {
    const agentSegment = slugifySegment(agent?.name || session.agentId || 'shared', 'shared')
    const sessionSegment = slugifySegment(session.name || session.id, session.id)
    const dir = path.join(SESSION_ARCHIVE_EXPORT_DIR, agentSegment)
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${sessionSegment}-${session.id}.md`)
    fs.writeFileSync(filePath, buildSessionArchiveMarkdown(session, payload, agent))
    return filePath
  } catch {
    return null
  }
}

export function syncSessionArchiveMemory(
  session: Session,
  opts?: { agent?: Partial<Agent> | null },
): { stored: boolean; memoryId?: string; reason?: string } {
  const agent = opts?.agent ?? (session.agentId ? loadAgents()[session.agentId] : null)
  if (!session.agentId && !agent?.id) {
    return { stored: false, reason: 'missing_agent' }
  }

  const payload = buildSessionArchivePayload(session, agent)
  if (!payload) {
    return { stored: false, reason: 'insufficient_messages' }
  }

  const memDb = getMemoryDb()
  const existing = memDb.getLatestBySessionCategory(session.id, 'session_archive')
  const existingHash = typeof existing?.metadata?.archiveHash === 'string'
    ? existing.metadata.archiveHash
    : null
  if (session.sessionArchiveState?.lastHash === payload.hash || existingHash === payload.hash) {
    session.sessionArchiveState = {
      memoryId: session.sessionArchiveState?.memoryId || existing?.id || null,
      lastHash: payload.hash,
      lastSyncedAt: session.sessionArchiveState?.lastSyncedAt || existing?.updatedAt || null,
      messageCount: getMessageCount(session.id),
      exportPath: session.sessionArchiveState?.exportPath || null,
    }
    return { stored: false, memoryId: existing?.id || session.sessionArchiveState.memoryId || undefined, reason: 'unchanged' }
  }
  const entry: MemoryEntry | null = existing
    ? memDb.update(existing.id, {
        title: payload.title,
        content: payload.content,
        metadata: payload.metadata,
        references: payload.references,
        linkedMemoryIds: existing.linkedMemoryIds,
      })
    : memDb.add({
        agentId: session.agentId || agent?.id || null,
        sessionId: session.id,
        category: 'session_archive',
        title: payload.title,
        content: payload.content,
        metadata: payload.metadata,
        references: payload.references,
        linkedMemoryIds: [],
      })

  if (!entry) return { stored: false, reason: 'store_failed' }
  const exportPath = exportSessionArchiveMarkdown(session, payload, agent)

  session.sessionArchiveState = {
    memoryId: entry.id,
    lastHash: payload.hash,
    lastSyncedAt: Date.now(),
    messageCount: getMessageCount(session.id),
    exportPath,
  }

  return { stored: true, memoryId: entry.id }
}

export function syncAllSessionArchiveMemories(): { synced: number; skipped: number; sessionIds: string[] } {
  const sessions = loadSessions()
  const agents = loadAgents()
  let changed = false
  let synced = 0
  let skipped = 0
  const sessionIds: string[] = []

  for (const session of Object.values(sessions) as Session[]) {
    const agent = session.agentId ? agents[session.agentId] : null
    const result = syncSessionArchiveMemory(session, { agent })
    if (result.stored) {
      synced += 1
      sessionIds.push(session.id)
      changed = true
    } else {
      skipped += 1
    }
  }

  if (changed) saveSessions(sessions)
  return { synced, skipped, sessionIds }
}
