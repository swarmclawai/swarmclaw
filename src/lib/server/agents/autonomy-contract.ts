import type { GoalContract } from '@/types'

const PLAN_LINE_RE = /\[MAIN_LOOP_PLAN\]\s*(\{[^\n]*\})/i
const REVIEW_LINE_RE = /\[MAIN_LOOP_REVIEW\]\s*(\{[^\n]*\})/i

export interface MainLoopPlanMeta {
  steps?: string[]
  current_step?: string
}

export interface MainLoopReviewMeta {
  note?: string
  confidence?: number
  needs_replan?: boolean
}

function cleanText(value: string, max = 400): string {
  return (value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function uniqueStrings(input: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of input) {
    const normalized = cleanText(value, 240)
    if (!normalized || seen.has(normalized.toLowerCase())) continue
    seen.add(normalized.toLowerCase())
    out.push(normalized)
  }
  return out
}

function safeJsonParse<T>(value: string): T | null {
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T
  } catch {
    // ignore malformed json
  }
  return null
}

function parseTaggedJsonLine<T>(text: string, tagRegex: RegExp): T | null {
  const raw = (text || '').trim()
  if (!raw) return null
  const tagged = raw.match(tagRegex)?.[1]
  if (tagged) {
    const parsed = safeJsonParse<T>(tagged)
    if (parsed) return parsed
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue
    const parsed = safeJsonParse<T>(trimmed)
    if (parsed) return parsed
  }
  return null
}

function parseBudgetUsd(text: string): number | null {
  const patterns = [
    /budget[^$\d]{0,20}\$?\s*(\d+(?:\.\d+)?)/i,
    /\$\s*(\d+(?:\.\d+)?)/,
    /(\d+(?:\.\d+)?)\s*(usd|dollars?)/i,
  ]
  for (const re of patterns) {
    const m = text.match(re)
    if (!m?.[1]) continue
    const num = Number.parseFloat(m[1])
    if (!Number.isFinite(num)) continue
    return Math.max(0, Math.min(1_000_000, num))
  }
  return null
}

function parseDeadlineAt(text: string): number | null {
  const patterns = [
    /\bby\s+([A-Za-z]{3,10}\s+\d{1,2},?\s+\d{4})/i,
    /\bby\s+(\d{4}-\d{2}-\d{2})/i,
    /\bdeadline[^A-Za-z0-9]{0,8}([A-Za-z]{3,10}\s+\d{1,2},?\s+\d{4})/i,
    /\bdeadline[^A-Za-z0-9]{0,8}(\d{4}-\d{2}-\d{2})/i,
  ]
  for (const re of patterns) {
    const value = text.match(re)?.[1]
    if (!value) continue
    const ts = Date.parse(value)
    if (!Number.isFinite(ts)) continue
    return ts
  }
  return null
}

function parseSuccessMetric(text: string): string | null {
  const patterns = [
    /success(?:\s+is|\s+means|\s+metric)?\s*[:=-]\s*([^\n.]{4,180})/i,
    /metric\s*[:=-]\s*([^\n.]{4,180})/i,
    /kpi\s*[:=-]\s*([^\n.]{4,180})/i,
  ]
  for (const re of patterns) {
    const value = cleanText(text.match(re)?.[1] || '', 180)
    if (value) return value
  }
  return null
}

function parseObjective(text: string): string | null {
  const direct = cleanText(text, 300)
  if (!direct) return null
  const firstSentence = direct.split(/(?<=[.!?])\s+/)[0]?.trim() || direct
  return cleanText(firstSentence, 300) || null
}

function parseConstraints(text: string): string[] {
  const constraints: string[] = []
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  for (const line of lines) {
    if (/^(must|should|avoid|without|do not|don't|within|under|limit)/i.test(line)) {
      constraints.push(line.replace(/^[-*]\s*/, ''))
      continue
    }
    if (/constraint[s]?\s*[:=-]/i.test(line)) {
      const value = line.split(/[:=-]/).slice(1).join(':').trim()
      if (value) constraints.push(value)
    }
  }
  return uniqueStrings(constraints).slice(0, 8)
}

export function parseGoalContractFromText(text: string): GoalContract | null {
  const objective = parseObjective(text || '')
  if (!objective) return null
  const constraints = parseConstraints(text || '')
  const budgetUsd = parseBudgetUsd(text || '')
  const deadlineAt = parseDeadlineAt(text || '')
  const successMetric = parseSuccessMetric(text || '')
  return {
    objective,
    constraints: constraints.length ? constraints : undefined,
    budgetUsd: budgetUsd ?? null,
    deadlineAt: deadlineAt ?? null,
    successMetric: successMetric || null,
  }
}

export function mergeGoalContracts(
  current: GoalContract | null | undefined,
  next: GoalContract | null | undefined,
): GoalContract | null {
  if (!current && !next) return null
  if (!current) return next || null
  if (!next) return current
  return {
    objective: next.objective || current.objective,
    constraints: next.constraints?.length ? next.constraints : current.constraints,
    budgetUsd: next.budgetUsd ?? current.budgetUsd ?? null,
    deadlineAt: next.deadlineAt ?? current.deadlineAt ?? null,
    successMetric: next.successMetric || current.successMetric || null,
  }
}

export function parseMainLoopPlan(text: string): MainLoopPlanMeta | null {
  const parsed = parseTaggedJsonLine<Record<string, unknown>>(text, PLAN_LINE_RE)
  if (!parsed) return null
  const steps = Array.isArray(parsed.steps)
    ? uniqueStrings(parsed.steps.filter((v): v is string => typeof v === 'string')).slice(0, 8)
    : []
  const currentStep = typeof parsed.current_step === 'string'
    ? cleanText(parsed.current_step, 220)
    : ''
  if (!steps.length && !currentStep) return null
  return {
    steps: steps.length ? steps : undefined,
    current_step: currentStep || undefined,
  }
}

export function parseMainLoopReview(text: string): MainLoopReviewMeta | null {
  const parsed = parseTaggedJsonLine<Record<string, unknown>>(text, REVIEW_LINE_RE)
  if (!parsed) return null
  const note = typeof parsed.note === 'string' ? cleanText(parsed.note, 320) : ''
  const confidenceRaw = typeof parsed.confidence === 'number'
    ? parsed.confidence
    : typeof parsed.confidence === 'string'
      ? Number.parseFloat(parsed.confidence)
      : Number.NaN
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : undefined
  const needsReplan = parsed.needs_replan === true
    ? true
    : parsed.needs_replan === false
      ? false
      : undefined
  if (!note && typeof confidence !== 'number' && typeof needsReplan !== 'boolean') return null
  return {
    note: note || undefined,
    confidence,
    needs_replan: needsReplan,
  }
}
