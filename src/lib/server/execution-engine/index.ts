import { enqueueSessionRun } from '@/lib/server/runtime/session-run-manager'
import type { ExecuteChatTurnResult } from '@/lib/server/chat-execution/chat-execution-types'
import type {
  EnqueueExecutionRequest,
  ExecutionHandle,
} from '@/lib/server/execution-engine/types'
import { enqueueTaskAttemptExecution } from '@/lib/server/execution-engine/task-attempt'

export function enqueueExecution(
  input: EnqueueExecutionRequest,
): ExecutionHandle<ExecuteChatTurnResult> {
  if (input.kind === 'session_turn') {
    const result = enqueueSessionRun(input.input)
    return {
      executionId: result.runId,
      promise: result.promise,
      abort: result.abort,
      position: result.position,
      deduped: result.deduped,
      coalesced: result.coalesced,
      unsubscribe: result.unsubscribe,
    }
  }

  return enqueueTaskAttemptExecution(input)
}

export { executeExecutionChatTurn } from '@/lib/server/execution-engine/chat-turn'
export type {
  EnqueueExecutionRequest,
  EnqueueTaskAttemptExecutionRequest,
  EnqueueSessionTurnExecutionRequest,
  ExecutionHandle,
  ExecutionResult,
} from '@/lib/server/execution-engine/types'
