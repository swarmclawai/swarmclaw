import type { Message, Session } from '@/types'
import { perf } from '@/lib/server/runtime/perf'
import { log } from '@/lib/server/logger'
import { getDb, withTransaction, loadSession, patchSession } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'

const TAG = 'message-repo'
const MAX_SUMMARY_TEXT = 280

// ---------------------------------------------------------------------------
// Prepared statements — lazily created so the db is fully initialised first
// ---------------------------------------------------------------------------

type Stmts = ReturnType<typeof buildStatements>
let _stmts: Stmts | null = null

function stmts(): Stmts {
  if (!_stmts) _stmts = buildStatements()
  return _stmts
}

function buildStatements() {
  const db = getDb()
  return {
    selectAll: db.prepare(
      'SELECT data FROM session_messages WHERE session_id = ? ORDER BY seq ASC',
    ),
    selectCount: db.prepare(
      'SELECT COUNT(*) as count FROM session_messages WHERE session_id = ?',
    ),
    selectLast: db.prepare(
      'SELECT data FROM session_messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1',
    ),
    selectRecent: db.prepare(
      'SELECT data FROM session_messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?',
    ),
    selectMaxSeq: db.prepare(
      'SELECT MAX(seq) as maxSeq FROM session_messages WHERE session_id = ?',
    ),
    insert: db.prepare(
      'INSERT INTO session_messages (session_id, seq, data) VALUES (?, ?, ?)',
    ),
    update: db.prepare(
      'UPDATE session_messages SET data = ? WHERE session_id = ? AND seq = ?',
    ),
    deleteAfter: db.prepare(
      'DELETE FROM session_messages WHERE session_id = ? AND seq > ?',
    ),
    deleteAll: db.prepare(
      'DELETE FROM session_messages WHERE session_id = ?',
    ),
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function nextSeq(sessionId: string): number {
  const row = stmts().selectMaxSeq.get(sessionId) as { maxSeq: number | null } | undefined
  return (row?.maxSeq ?? -1) + 1
}

function rowCount(sessionId: string): number {
  return (stmts().selectCount.get(sessionId) as { count: number }).count
}

function parseMsg(raw: string): Message | null {
  try {
    return JSON.parse(raw) as Message
  } catch {
    return null
  }
}

function summarizeForMeta(message: Message): Message {
  return {
    role: message.role,
    text: typeof message.text === 'string' ? message.text.slice(0, MAX_SUMMARY_TEXT) : '',
    time: message.time,
    kind: message.kind,
    source: message.source,
    suppressed: message.suppressed,
    streaming: message.streaming,
    bookmarked: message.bookmarked,
  }
}

// ---------------------------------------------------------------------------
// Session metadata sync — keeps messageCount / lastMessageSummary on the blob
// ---------------------------------------------------------------------------

function syncSessionMeta(sessionId: string): void {
  const count = rowCount(sessionId)
  const lastRow = stmts().selectLast.get(sessionId) as { data: string } | undefined
  const lastMsg = lastRow ? parseMsg(lastRow.data) : null

  patchSession(sessionId, (current) => {
    if (!current) return null
    current.messageCount = count
    current.lastMessageSummary = lastMsg ? summarizeForMeta(lastMsg) : null
    if (lastMsg?.role === 'assistant' && typeof lastMsg.time === 'number') {
      current.lastAssistantAt = lastMsg.time
    }
    current.lastActiveAt = Date.now()
    return current
  })
}

// ---------------------------------------------------------------------------
// Lazy migration — copies blob messages → table on first access
// ---------------------------------------------------------------------------

function ensureMigrated(sessionId: string): void {
  if (rowCount(sessionId) > 0) return
  lazyMigrateSession(sessionId)
}

function lazyMigrateSession(sessionId: string): Message[] | null {
  const session = loadSession(sessionId)
  if (!session || !Array.isArray(session.messages) || session.messages.length === 0) {
    return null
  }

  const messages = session.messages
  log.info(TAG, `Lazy-migrating ${messages.length} messages for session ${sessionId}`)

  withTransaction(() => {
    // Double-check inside transaction to prevent duplicate migration
    if (rowCount(sessionId) > 0) return

    const ins = stmts().insert
    for (let i = 0; i < messages.length; i++) {
      ins.run(sessionId, i, JSON.stringify(messages[i]))
    }

    // Compute metadata on the blob (keep messages intact for backward compat)
    const lastMsg = messages[messages.length - 1]
    let lastAssistantAt: number | null = null
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && typeof messages[i].time === 'number') {
        lastAssistantAt = messages[i].time
        break
      }
    }

    patchSession(sessionId, (current) => {
      if (!current) return null
      current.messageCount = messages.length
      current.lastMessageSummary = lastMsg ? summarizeForMeta(lastMsg) : null
      if (lastAssistantAt !== null && typeof current.lastAssistantAt !== 'number') {
        current.lastAssistantAt = lastAssistantAt
      }
      return current
    })
  })

  return messages
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Return all messages for a session, ordered by sequence. */
export function getMessages(sessionId: string): Message[] {
  return perf.measureSync('message-repo', 'getMessages', () => {
    const rows = stmts().selectAll.all(sessionId) as Array<{ data: string }>

    // Lazy migration: populate table from session blob on first read
    if (rows.length === 0) {
      const migrated = lazyMigrateSession(sessionId)
      if (migrated) return migrated
    }

    const out: Message[] = []
    for (const row of rows) {
      const m = parseMsg(row.data)
      if (m) out.push(m)
    }
    return out
  }, { sessionId })
}

/** Return message count (from table, with blob fallback pre-migration). */
export function getMessageCount(sessionId: string): number {
  return perf.measureSync('message-repo', 'getMessageCount', () => {
    const count = rowCount(sessionId)
    if (count > 0) return count
    // Pre-migration fallback
    const session = loadSession(sessionId)
    return Array.isArray(session?.messages) ? session.messages.length : 0
  }, { sessionId })
}

/** Return the last message (from table, with blob fallback). */
export function getLastMessage(sessionId: string): Message | null {
  return perf.measureSync('message-repo', 'getLastMessage', () => {
    const row = stmts().selectLast.get(sessionId) as { data: string } | undefined
    if (row) return parseMsg(row.data)
    const session = loadSession(sessionId)
    const msgs = session?.messages
    return Array.isArray(msgs) && msgs.length > 0 ? msgs[msgs.length - 1] : null
  }, { sessionId })
}

/** Return the last N messages in chronological order. */
export function getRecentMessages(sessionId: string, n: number): Message[] {
  return perf.measureSync('message-repo', 'getRecentMessages', () => {
    const rows = stmts().selectRecent.all(sessionId, n) as Array<{ data: string }>
    if (rows.length > 0) {
      const out: Message[] = []
      for (const row of rows) {
        const m = parseMsg(row.data)
        if (m) out.push(m)
      }
      return out.reverse() // DESC → ASC
    }
    // Pre-migration fallback
    const session = loadSession(sessionId)
    return Array.isArray(session?.messages) ? session.messages.slice(-n) : []
  }, { sessionId, n })
}

/** Append a single message. Returns the assigned sequence number. */
export function appendMessage(sessionId: string, message: Message): number {
  return perf.measureSync('message-repo', 'appendMessage', () => {
    ensureMigrated(sessionId)
    const seq = nextSeq(sessionId)
    stmts().insert.run(sessionId, seq, JSON.stringify(message))
    syncSessionMeta(sessionId)
    notify('messages', 'append', sessionId)
    return seq
  }, { sessionId })
}

/** Append multiple messages in a single transaction. */
export function appendMessages(sessionId: string, messages: Message[]): void {
  if (!messages.length) return
  perf.measureSync('message-repo', 'appendMessages', () => {
    ensureMigrated(sessionId)
    withTransaction(() => {
      let seq = nextSeq(sessionId)
      const ins = stmts().insert
      for (const msg of messages) {
        ins.run(sessionId, seq++, JSON.stringify(msg))
      }
    })
    syncSessionMeta(sessionId)
    notify('messages', 'append', sessionId)
  }, { sessionId, count: messages.length })
}

/** Replace the message at a given sequence number (e.g. replace-last-assistant). */
export function replaceMessageAt(sessionId: string, seq: number, message: Message): void {
  perf.measureSync('message-repo', 'replaceMessageAt', () => {
    stmts().update.run(JSON.stringify(message), sessionId, seq)
    syncSessionMeta(sessionId)
    notify('messages', 'update', sessionId)
  }, { sessionId, seq })
}

/** Delete all messages with seq > the given value (edit-and-resend). */
export function truncateAfter(sessionId: string, seq: number): void {
  perf.measureSync('message-repo', 'truncateAfter', () => {
    stmts().deleteAfter.run(sessionId, seq)
    syncSessionMeta(sessionId)
    notify('messages', 'truncate', sessionId)
  }, { sessionId, seq })
}

/** Remove all messages for a session. */
export function clearMessages(sessionId: string): void {
  perf.measureSync('message-repo', 'clearMessages', () => {
    stmts().deleteAll.run(sessionId)
    syncSessionMeta(sessionId)
    notify('messages', 'clear', sessionId)
  }, { sessionId })
}

/** Replace the entire message list (used after in-memory prune operations). */
export function replaceAllMessages(sessionId: string, messages: Message[]): void {
  perf.measureSync('message-repo', 'replaceAllMessages', () => {
    withTransaction(() => {
      stmts().deleteAll.run(sessionId)
      const ins = stmts().insert
      for (let i = 0; i < messages.length; i++) {
        ins.run(sessionId, i, JSON.stringify(messages[i]))
      }
    })
    syncSessionMeta(sessionId)
    notify('messages', 'replace', sessionId)
  }, { sessionId, count: messages.length })
}

/** Cleanup: delete all rows for a session (called on session delete). */
export function deleteSessionMessages(sessionId: string): void {
  stmts().deleteAll.run(sessionId)
}

// ---------------------------------------------------------------------------
// Bulk migration (for CLI / admin endpoint)
// ---------------------------------------------------------------------------

export function migrateAllSessions(): { migrated: number; skipped: number; total: number } {
  const db = getDb()
  const rows = db.prepare('SELECT id, data FROM sessions').all() as Array<{ id: string; data: string }>
  let migrated = 0
  let skipped = 0

  for (const row of rows) {
    try {
      const session = JSON.parse(row.data) as Session
      if (!Array.isArray(session.messages) || session.messages.length === 0) {
        skipped++
        continue
      }
      if (rowCount(row.id) > 0) {
        skipped++
        continue
      }
      lazyMigrateSession(row.id)
      migrated++
    } catch {
      skipped++
    }
  }

  return { migrated, skipped, total: rows.length }
}
