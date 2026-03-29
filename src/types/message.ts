import type { MessageSource } from './connector'

export interface MessageToolEvent {
  name: string
  input: string
  output?: string
  error?: boolean
  /** Internal correlation token for matching streaming tool calls/results. */
  toolCallId?: string
}

export type MessageTaskIntent = 'coding' | 'research' | 'browsing' | 'outreach' | 'scheduling' | 'general'
export type MessageWorkType = 'coding' | 'research' | 'writing' | 'review' | 'operations' | 'general'

export interface MessageSemanticsSummary {
  taskIntent: MessageTaskIntent
  workType: MessageWorkType
  isDeliverableTask: boolean
  isBroadGoal: boolean
  isResearchSynthesis: boolean
  isLightweightDirectChat?: boolean
  hasHumanSignals: boolean
  hasSignificantEvent: boolean
  wantsScreenshots?: boolean
  wantsOutboundDelivery?: boolean
  wantsVoiceDelivery?: boolean
  explicitToolRequests: string[]
  confidence: number
}

export interface Message {
  role: 'user' | 'assistant'
  text: string
  time: number
  /** Client-only render identity used to keep in-progress transcript rows stable. */
  clientRenderId?: string
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  toolEvents?: MessageToolEvent[]
  thinking?: string
  kind?: 'chat' | 'heartbeat' | 'system' | 'context-clear' | 'extension-ui' | 'connector-delivery'
  suppressed?: boolean
  bookmarked?: boolean
  suggestions?: string[]
  replyToId?: string
  source?: MessageSource
  /** Persist in the UI transcript, but exclude from normal model history. */
  historyExcluded?: boolean
  /** True while the message is still being streamed — cleared on final persist. */
  streaming?: boolean
  /** Run ID that produced this message — used to scope streaming artifact replacement. */
  runId?: string
  /** Cached turn semantics used for routing, delegation, and reflection. */
  semantics?: MessageSemanticsSummary
}
