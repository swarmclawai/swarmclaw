import type { MessageToolEvent, SSEEvent } from '@/types'

export interface ExecuteChatTurnInput {
  sessionId: string
  message: string
  missionId?: string | null
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
  missionId?: string | null
  text: string
  persisted: boolean
  toolEvents: MessageToolEvent[]
  error?: string
  inputTokens?: number
  outputTokens?: number
  estimatedCost?: number
}
