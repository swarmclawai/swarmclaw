import { executeSessionChatTurn } from '@/lib/server/chat-execution/chat-execution'
import type {
  ExecuteChatTurnInput,
  ExecuteChatTurnResult,
} from '@/lib/server/chat-execution/chat-execution-types'

export function executeExecutionChatTurn(input: ExecuteChatTurnInput): Promise<ExecuteChatTurnResult> {
  return executeSessionChatTurn(input)
}
