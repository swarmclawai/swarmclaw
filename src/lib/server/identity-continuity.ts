import type { Agent, IdentityContinuityState, Session } from '@/types'

function normalizeText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, maxChars) : null
}

function normalizeList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value) {
    const normalized = normalizeText(raw, maxChars)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
    if (out.length >= maxItems) break
  }
  return out
}

export function normalizeIdentityContinuityState(raw: unknown): IdentityContinuityState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const state: IdentityContinuityState = {
    selfSummary: normalizeText(record.selfSummary, 320),
    relationshipSummary: normalizeText(record.relationshipSummary, 320),
    personaLabel: normalizeText(record.personaLabel, 120),
    toneStyle: normalizeText(record.toneStyle, 120),
    boundaries: normalizeList(record.boundaries, 6, 180),
    continuityNotes: normalizeList(record.continuityNotes, 8, 220),
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? Math.trunc(record.updatedAt)
      : null,
  }
  return state
}

function fallbackSelfSummary(agent?: Partial<Agent> | null): string | null {
  const description = normalizeText(agent?.description, 220)
  if (description) return `${agent?.name || 'Agent'}: ${description}`
  const soul = normalizeText(agent?.soul, 220)
  if (soul) return `${agent?.name || 'Agent'}: ${soul}`
  const name = normalizeText(agent?.name, 80)
  return name ? `${name}: persistent companion agent` : null
}

function fallbackPersonaLabel(session?: Partial<Session> | null, agent?: Partial<Agent> | null): string | null {
  const threadPersona = normalizeText(session?.connectorContext?.threadPersonaLabel, 120)
  if (threadPersona) return threadPersona
  const threadTitle = normalizeText(session?.connectorContext?.threadTitle, 120)
  if (threadTitle) return threadTitle
  const threadId = normalizeText(session?.connectorContext?.threadId, 80)
  if (threadId) return `${agent?.name || 'Agent'} thread ${threadId}`
  const sessionName = normalizeText(session?.name, 120)
  if (sessionName && !/^new chat$/i.test(sessionName)) return sessionName
  return null
}

function fallbackRelationshipSummary(session?: Partial<Session> | null): string | null {
  const sender = normalizeText(session?.connectorContext?.senderName, 80)
  if (sender) return `Ongoing conversation with ${sender}.`
  const user = normalizeText(session?.user, 80)
  if (user && user !== 'user') return `Ongoing conversation with ${user}.`
  return 'Ongoing conversation with the user.'
}

export function buildIdentityContinuityContext(
  session?: Partial<Session> | null,
  agent?: Partial<Agent> | null,
): string {
  const agentState = normalizeIdentityContinuityState(agent?.identityState)
  const sessionState = normalizeIdentityContinuityState(session?.identityState)
  const selfSummary = sessionState?.selfSummary || agentState?.selfSummary || fallbackSelfSummary(agent)
  const relationshipSummary = sessionState?.relationshipSummary || agentState?.relationshipSummary || fallbackRelationshipSummary(session)
  const personaLabel = sessionState?.personaLabel || fallbackPersonaLabel(session, agent)
  const toneStyle = sessionState?.toneStyle || normalizeText(session?.conversationTone, 80) || agentState?.toneStyle
  const boundaries = sessionState?.boundaries?.length
    ? sessionState.boundaries
    : agentState?.boundaries?.length
      ? agentState.boundaries
      : []
  const continuityNotes = [
    ...(agentState?.continuityNotes || []),
    ...(sessionState?.continuityNotes || []),
  ].slice(-6)

  const lines: string[] = []
  if (selfSummary) lines.push(`Core self: ${selfSummary}`)
  if (personaLabel) lines.push(`Current persona: ${personaLabel}`)
  if (relationshipSummary) lines.push(`Relationship context: ${relationshipSummary}`)
  if (toneStyle) lines.push(`Observed tone: ${toneStyle}`)
  if (boundaries.length) lines.push(`Boundaries: ${boundaries.join(' | ')}`)
  if (continuityNotes.length) lines.push(`Continuity notes: ${continuityNotes.join(' | ')}`)
  if (!lines.length) return ''
  return `## Identity Continuity\n${lines.join('\n')}`
}

export function refreshSessionIdentityState(
  session: Session,
  agent?: Partial<Agent> | null,
  now = Date.now(),
): IdentityContinuityState {
  const existing = normalizeIdentityContinuityState(session.identityState) || {}
  const agentState = normalizeIdentityContinuityState(agent?.identityState) || {}
  const boundaries = existing.boundaries?.length ? existing.boundaries : (agentState.boundaries || [])
  const continuityNotes = [
    ...(agentState.continuityNotes || []),
    ...(existing.continuityNotes || []),
  ].slice(-8)

  const next: IdentityContinuityState = {
    selfSummary: existing.selfSummary || agentState.selfSummary || fallbackSelfSummary(agent),
    relationshipSummary: existing.relationshipSummary || agentState.relationshipSummary || fallbackRelationshipSummary(session),
    personaLabel: existing.personaLabel || fallbackPersonaLabel(session, agent),
    toneStyle: normalizeText(session.conversationTone, 80) || existing.toneStyle || agentState.toneStyle,
    boundaries,
    continuityNotes,
    updatedAt: now,
  }

  session.identityState = next
  return next
}
