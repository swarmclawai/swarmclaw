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

export function isMainSession(session: unknown): boolean {
  void session
  return false
}

export function buildMainLoopHeartbeatPrompt(session: unknown, fallbackPrompt: string): string {
  void session
  return fallbackPrompt
}

export function stripMainLoopMetaForPersistence(text: string): string {
  return (text || '')
    .split('\n')
    .filter((line) => !LEGACY_META_LINE_RE.test(line))
    .join('\n')
    .trim()
}

export function getMainLoopStateForSession(sessionId: string): MainLoopState | null {
  void sessionId
  return null
}

export function setMainLoopStateForSession(sessionId: string, patch: Partial<MainLoopState>): MainLoopState | null {
  void sessionId
  void patch
  return null
}

export function pushMainLoopEventToMainSessions(input: PushMainLoopEventInput): number {
  void input
  return 0
}

export function handleMainLoopRunResult(input: HandleMainLoopRunResultInput): MainLoopFollowupRequest | null {
  void input
  return null
}
