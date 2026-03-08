import type { Message, MessageToolEvent } from '@/types'
import { loadSessions, saveSessions } from './storage'
import { notify } from './ws-hub'

export interface SessionNoteInput {
  sessionId: string
  text: string
  role?: Message['role']
  kind?: Message['kind']
  toolEvents?: MessageToolEvent[]
  time?: number
}

export function buildSessionNoteMessage(input: Omit<SessionNoteInput, 'sessionId'>): Message | null {
  const trimmed = String(input.text || '').trim()
  if (!trimmed) return null
  return {
    role: input.role || 'assistant',
    kind: input.kind || 'system',
    text: trimmed,
    time: typeof input.time === 'number' && Number.isFinite(input.time) ? input.time : Date.now(),
    ...(Array.isArray(input.toolEvents) && input.toolEvents.length ? { toolEvents: input.toolEvents } : {}),
  }
}

export function appendSessionNote(input: SessionNoteInput): Message | null {
  const sessions = loadSessions()
  const session = sessions[input.sessionId]
  if (!session) return null
  if (!Array.isArray(session.messages)) session.messages = []

  const next = buildSessionNoteMessage(input)
  if (!next) return null

  session.messages.push(next)
  session.lastActiveAt = next.time
  sessions[input.sessionId] = session
  saveSessions(sessions)
  notify('sessions')
  notify(`messages:${input.sessionId}`)
  return next
}
