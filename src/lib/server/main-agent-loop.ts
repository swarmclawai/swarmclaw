import type { GoalContract, MessageToolEvent } from '@/types'

const LEGACY_META_LINE_RE = /\[(?:MAIN_LOOP_META|MAIN_LOOP_PLAN|MAIN_LOOP_REVIEW|AGENT_HEARTBEAT_META)\]\s*(\{[^\n]*\})?/i

export interface MainLoopState {
  goal: string | null
  goalContract: GoalContract | null
  summary: string | null
  nextAction: string | null
  planSteps: string[]
  currentPlanStep: string | null
  reviewNote: string | null
  reviewConfidence: number | null
  missionTaskId: string | null
  momentumScore: number
  paused: boolean
  status: 'idle' | 'progress' | 'blocked' | 'ok'
  autonomyMode: 'assist' | 'autonomous'
  pendingEvents: Array<{
    id: string
    type: string
    text: string
    createdAt: number
  }>
  timeline: Array<{
    id: string
    at: number
    source: string
    note: string
    status?: 'idle' | 'progress' | 'blocked' | 'ok' | 'reflection'
  }>
  missionTokens: number
  missionCostUsd: number
  followupChainCount: number
  metaMissCount: number
  workingMemoryNotes: string[]
  lastMemoryNoteAt: number | null
  lastPlannedAt: number | null
  lastReviewedAt: number | null
  lastTickAt: number | null
  updatedAt: number
}

export interface MainLoopFollowupRequest {
  message: string
  delayMs: number
  dedupeKey: string
}

export interface PushMainLoopEventInput {
  type: string
  text: string
  user?: string | null
}

export interface HandleMainLoopRunResultInput {
  sessionId: string
  message: string
  internal: boolean
  source: string
  resultText: string
  error?: string
  toolEvents?: MessageToolEvent[]
  inputTokens?: number
  outputTokens?: number
  estimatedCost?: number
}

export function isMainSession(_session: unknown): boolean {
  return false
}

export function buildMainLoopHeartbeatPrompt(_session: unknown, fallbackPrompt: string): string {
  return fallbackPrompt
}

export function stripMainLoopMetaForPersistence(text: string): string {
  return (text || '')
    .split('\n')
    .filter((line) => !LEGACY_META_LINE_RE.test(line))
    .join('\n')
    .trim()
}

export function getMainLoopStateForSession(_sessionId: string): MainLoopState | null {
  return null
}

export function setMainLoopStateForSession(_sessionId: string, _patch: Partial<MainLoopState>): MainLoopState | null {
  return null
}

export function pushMainLoopEventToMainSessions(_input: PushMainLoopEventInput): number {
  return 0
}

export function handleMainLoopRunResult(_input: HandleMainLoopRunResultInput): MainLoopFollowupRequest | null {
  return null
}
