import type { MemoryEntry } from '@/types'

const ACK_RE = /^(?:ok(?:ay)?|cool|nice|got it|makes sense|thanks|thank you|thx|roger|copy|sounds good|sgtm|yep|yup|y|nope?|nah|kk|done)[.! ]*$/i
const GREETING_RE = /^(?:hi|hello|hey|yo|morning|good morning|good afternoon|good evening)[.! ]*$/i
const MEMORY_META_RE = /\b(?:remember|memory|memorize|store this|save this|forget)\b/i
const LOW_SIGNAL_RESPONSE_RE = /^(?:HEARTBEAT_OK|NO_MESSAGE)\b/i
const CURRENT_THREAD_RECALL_MARKER_RE = /\b(?:this conversation|this chat|this thread|current conversation|current chat|current thread|same thread|same chat|same conversation|earlier in (?:this )?(?:conversation|chat|thread)|from (?:this|our) (?:conversation|chat|thread)|you just stored|you just said|we just discussed|we just decided)\b/i
const CURRENT_THREAD_RECALL_INTENT_RE = /\b(?:what|which|who|when|where|did|remind|recap|summarize|repeat|list|tell me|answer|confirm|recall|mention)\b/i
const DIRECT_MEMORY_WRITE_MARKER_RE = /\b(?:remember|memorize|store (?:this|that|the fact|it)|save (?:this|that|the fact|it) (?:to|in) memory|write to memory|add to memory|update.*memory|correct.*memory)\b/i
const DIRECT_MEMORY_WRITE_FOLLOWUP_RE = /\b(?:confirm|recap|repeat|summarize|what you just stored|what you saved|what you updated)\b/i

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function lower(value: string | null | undefined): string {
  return normalizeWhitespace(value || '').toLowerCase()
}

export function shouldInjectMemoryContext(message: string): boolean {
  const trimmed = normalizeWhitespace(message)
  if (!trimmed) return false
  if (trimmed.length < 16 && (ACK_RE.test(trimmed) || GREETING_RE.test(trimmed))) return false
  if (trimmed.length < 24 && MEMORY_META_RE.test(trimmed)) return false
  return true
}

export function isCurrentThreadRecallRequest(message: string): boolean {
  const trimmed = normalizeWhitespace(message)
  if (!trimmed) return false
  if (!CURRENT_THREAD_RECALL_MARKER_RE.test(trimmed)) return false
  if (DIRECT_MEMORY_WRITE_MARKER_RE.test(trimmed) && DIRECT_MEMORY_WRITE_FOLLOWUP_RE.test(trimmed)) return false
  if (/\b(?:remember|store|save)\b/i.test(trimmed) && !/\?\s*$/.test(trimmed) && !/\b(?:what|which|who|when|where|did|confirm|recap|summarize|repeat|list|tell me|answer|recall)\b/i.test(trimmed)) {
    return false
  }
  return CURRENT_THREAD_RECALL_INTENT_RE.test(trimmed) || /\?\s*$/.test(trimmed)
}

export function shouldAutoCaptureMemoryTurn(message: string, response: string): boolean {
  const normalizedMessage = normalizeWhitespace(message)
  const normalizedResponse = normalizeWhitespace(response)
  if (normalizedMessage.length < 20 || normalizedResponse.length < 40) return false
  if (ACK_RE.test(normalizedMessage) || GREETING_RE.test(normalizedMessage)) return false
  if (LOW_SIGNAL_RESPONSE_RE.test(normalizedResponse)) return false
  if (MEMORY_META_RE.test(normalizedMessage) && normalizedMessage.length < 120) return false
  if (/^(?:sorry|i can(?:not|'t)|unable to|i do not have|i don't have)\b/i.test(normalizedResponse)) return false
  return true
}

export function shouldAutoCaptureMemory(
  input: { message?: string | null; response?: string | null } | string,
  response?: string,
): boolean {
  if (typeof input === 'string') {
    return shouldAutoCaptureMemoryTurn(input, response || '')
  }
  return shouldAutoCaptureMemoryTurn(input.message || '', input.response || '')
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function normalizeMemoryCategory(input: string | null | undefined, _title?: string | null, _content?: string | null): string {
  const explicit = lower(input)

  const mapExplicit = (value: string): string | null => {
    if (!value || value === 'note' || value === 'notes') return null
    if (['preference', 'preferences', 'likes', 'dislikes'].includes(value)) return 'identity/preferences'
    if (['identity', 'profile', 'persona'].includes(value)) return 'identity/profile'
    if (['relationship', 'relationships', 'people'].includes(value)) return 'identity/relationships'
    if (['contact', 'contacts'].includes(value)) return 'identity/contacts'
    if (['routine', 'routines', 'schedule', 'habit', 'habits'].includes(value)) return 'identity/routines'
    if (['event', 'events', 'life event', 'life events', 'significant', 'milestone'].includes(value)) return 'identity/events'
    if (['goal', 'goals', 'objective', 'objectives', 'target', 'targets'].includes(value)) return 'identity/goals'
    if (['instruction', 'instructions', 'directive', 'directives', 'standing order', 'rule', 'rules'].includes(value)) return 'knowledge/instructions'
    if (['decision', 'decisions', 'choice'].includes(value)) return 'projects/decisions'
    if (['learning', 'learnings', 'lesson', 'lessons'].includes(value)) return 'projects/learnings'
    if (['project', 'projects', 'task', 'tasks'].includes(value)) return 'projects/context'
    if (['error', 'errors', 'incident', 'incidents', 'failure', 'failures'].includes(value)) return 'execution/errors'
    if (['breadcrumb', 'execution', 'run', 'runs'].includes(value)) return 'operations/execution'
    if (['fact', 'facts', 'knowledge', 'reference'].includes(value)) return 'knowledge/facts'
    if (['working', 'scratch', 'draft'].includes(value)) return 'working/scratch'
    if (value.includes('/')) return value
    return value
  }

  const explicitMapped = mapExplicit(explicit)
  if (explicitMapped) return explicitMapped

  // No content-sniffing regex — the agent picks the category via the guidance
  // in its memory policy block. We just normalize explicit aliases above and
  // fall back to knowledge/facts for uncategorized entries.
  return explicit && explicit !== 'note' && explicit !== 'notes' ? explicit : 'knowledge/facts'
}

export function buildMemoryDoctorReport(entries: MemoryEntry[], agentId?: string | null): string {
  const topLevelCounts = new Map<string, number>()
  let pinned = 0
  let linked = 0
  let shared = 0

  for (const entry of entries) {
    const category = normalizeMemoryCategory(entry.category, entry.title, entry.content)
    const topLevel = category.split('/')[0] || 'other'
    topLevelCounts.set(topLevel, (topLevelCounts.get(topLevel) || 0) + 1)
    if (entry.pinned) pinned += 1
    if (entry.linkedMemoryIds?.length) linked += 1
    if (entry.sharedWith?.length) shared += 1
  }

  const categories = [...topLevelCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => `- ${name}: ${count}`)

  return [
    'Memory Doctor',
    `Agent scope: ${agentId || 'global/all'}`,
    `Visible memories: ${entries.length}`,
    `Pinned: ${pinned}`,
    `Linked: ${linked}`,
    `Shared: ${shared}`,
    categories.length ? 'Top-level categories:' : 'Top-level categories: none',
    ...(categories.length ? categories : []),
  ].join('\n')
}

export function inferAutomaticMemoryCategory(message: string, response: string): string {
  return normalizeMemoryCategory('note', message, response)
}
