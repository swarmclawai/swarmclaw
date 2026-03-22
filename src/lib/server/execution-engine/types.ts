import type { ExecuteChatTurnResult } from '@/lib/server/chat-execution/chat-execution-types'
import type { EnqueueSessionRunInput } from '@/lib/server/runtime/session-run-manager/types'
import type { Agent, BoardTask } from '@/types'

export interface ExecutionHandle<TResult> {
  executionId: string
  promise: Promise<TResult>
  abort: () => void
  position?: number
  deduped?: boolean
  coalesced?: boolean
  unsubscribe?: () => void
}

export interface EnqueueSessionTurnExecutionRequest {
  kind: 'session_turn'
  input: EnqueueSessionRunInput
}

export interface EnqueueTaskAttemptExecutionRequest {
  kind: 'task_attempt'
  task: BoardTask
  agent: Agent
  sessionId: string
  executionId?: string
  callerSignal?: AbortSignal
}

export type EnqueueExecutionRequest =
  | EnqueueSessionTurnExecutionRequest
  | EnqueueTaskAttemptExecutionRequest

export type ExecutionResult = ExecuteChatTurnResult
