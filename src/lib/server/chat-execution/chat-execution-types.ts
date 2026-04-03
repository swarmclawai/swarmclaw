import type {
  KnowledgeCitation,
  KnowledgeRetrievalTrace,
  MessageToolEvent,
  SSEEvent,
} from '@/types'

export interface ExecuteChatTurnInput {
  sessionId: string
  message: string
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  internal?: boolean
  source?: string
  runId?: string
  signal?: AbortSignal
  onEvent?: (event: SSEEvent) => void
  modelOverride?: string
  heartbeatConfig?: {
    ackMaxChars: number
    showOk: boolean
    showAlerts: boolean
    target: string | null
    lightContext?: boolean
    deliveryMode?: 'default' | 'tool_only' | 'silent'
  }
  replyToId?: string
}

export interface ExecuteChatTurnResult {
  runId?: string
  sessionId: string
  text: string
  persisted: boolean
  toolEvents: MessageToolEvent[]
  error?: string
  inputTokens?: number
  outputTokens?: number
  estimatedCost?: number
  citations?: KnowledgeCitation[]
  retrievalTrace?: KnowledgeRetrievalTrace | null
}
