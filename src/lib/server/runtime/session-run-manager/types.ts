import type { ExecuteChatTurnResult } from '@/lib/server/chat-execution/chat-execution'
import type {
  SessionRunHeartbeatConfig,
  SessionRunRecord,
  SSEEvent,
} from '@/types'

export type SessionQueueMode = 'followup' | 'steer' | 'collect'

export interface SessionRunQueueEntry {
  executionKey: string
  run: SessionRunRecord
  message: string
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  onEvents: Array<(event: SSEEvent) => void>
  signalController: AbortController
  maxRuntimeMs?: number
  modelOverride?: string
  heartbeatConfig?: SessionRunHeartbeatConfig
  replyToId?: string
  resolve: (value: ExecuteChatTurnResult) => void
  reject: (error: Error) => void
  promise: Promise<ExecuteChatTurnResult>
  nonHeartbeatCounted?: boolean
}

export interface SessionRunManagerState {
  runningByExecution: Map<string, SessionRunQueueEntry>
  queueByExecution: Map<string, SessionRunQueueEntry[]>
  runs: Map<string, SessionRunRecord>
  recentRunIds: string[]
  promises: Map<string, Promise<ExecuteChatTurnResult>>
  deferredDrainTimers: Map<string, ReturnType<typeof setTimeout>>
  activityLeaseRenewTimers: Map<string, ReturnType<typeof setInterval>>
  externalSessionHolds: Map<string, number>
  externalHoldTimers: Map<string, ReturnType<typeof setTimeout>>
  drainDepth: Map<string, number>
  lastQueuedAt: number
  nonHeartbeatWorkCount: Map<string, number>
}

export interface EnqueueSessionRunInput {
  sessionId: string
  message: string
  missionId?: string | null
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  internal?: boolean
  source?: string
  mode?: SessionQueueMode
  onEvent?: (event: SSEEvent) => void
  dedupeKey?: string
  maxRuntimeMs?: number
  modelOverride?: string
  heartbeatConfig?: SessionRunHeartbeatConfig
  replyToId?: string
  executionGroupKey?: string
  callerSignal?: AbortSignal
  recoveredFromRestart?: boolean
  recoveredFromRunId?: string
}

export interface EnqueueSessionRunResult {
  runId: string
  position: number
  deduped?: boolean
  coalesced?: boolean
  promise: Promise<ExecuteChatTurnResult>
  abort: () => void
  unsubscribe: () => void
}
