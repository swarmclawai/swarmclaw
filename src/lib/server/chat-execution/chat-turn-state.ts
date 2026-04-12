/**
 * Encapsulates the mutable state tracked across iterations of a single
 * agent chat turn.  Extracted from `streamAgentChatCore` to make the
 * snapshot / restore cycle explicit and impossible to forget a field.
 */
import type { ExtensionInvocationRecord, MessageToolEvent } from '@/types'
import type { LoopDetectionResult } from '@/lib/server/tool-loop-detection'
import { extractSuggestions } from '@/lib/server/suggestions'

export interface TurnStateSnapshot {
  fullText: string
  lastSegment: string
  lastSettledSegment: string
  needsTextSeparator: boolean
  accumulatedThinking: string
  hasToolCalls: boolean
  toolEventCount: number
  loopDetectionTriggered: LoopDetectionResult | null
  toolFrequencyBlocked: string | false
  terminalToolBoundary: 'memory_write' | 'durable_wait' | 'context_compaction' | null
  memoryWriteTerminalAllowed: boolean | null
  lastToolSummaryTextLen: number
}

export class ChatTurnState {
  fullText = ''
  lastSegment = ''
  lastSettledSegment = ''
  hasToolCalls = false
  needsTextSeparator = false
  totalInputTokens = 0
  totalOutputTokens = 0
  accumulatedThinking = ''
  extensionInvocations: ExtensionInvocationRecord[] = []
  streamedToolEvents: MessageToolEvent[] = []
  currentToolInputTokens = 0
  usedToolNames = new Set<string>()
  loopDetectionTriggered: LoopDetectionResult | null = null
  toolFrequencyBlocked: string | false = false
  terminalToolBoundary: 'memory_write' | 'durable_wait' | 'context_compaction' | null = null
  terminalToolResponse = ''
  memoryWriteTerminalAllowed: boolean | null = null
  lastToolSummaryTextLen = -1

  snapshot(): TurnStateSnapshot {
    return {
      fullText: this.fullText,
      lastSegment: this.lastSegment,
      lastSettledSegment: this.lastSettledSegment,
      needsTextSeparator: this.needsTextSeparator,
      accumulatedThinking: this.accumulatedThinking,
      hasToolCalls: this.hasToolCalls,
      toolEventCount: this.streamedToolEvents.length,
      loopDetectionTriggered: this.loopDetectionTriggered,
      toolFrequencyBlocked: this.toolFrequencyBlocked,
      terminalToolBoundary: this.terminalToolBoundary,
      memoryWriteTerminalAllowed: this.memoryWriteTerminalAllowed,
      lastToolSummaryTextLen: this.lastToolSummaryTextLen,
    }
  }

  restore(snap: TurnStateSnapshot): void {
    this.fullText = snap.fullText
    this.lastSegment = snap.lastSegment
    this.lastSettledSegment = snap.lastSettledSegment
    this.needsTextSeparator = snap.needsTextSeparator
    this.accumulatedThinking = snap.accumulatedThinking
    this.hasToolCalls = snap.hasToolCalls
    this.streamedToolEvents.length = snap.toolEventCount
    this.loopDetectionTriggered = snap.loopDetectionTriggered
    this.toolFrequencyBlocked = snap.toolFrequencyBlocked
    this.terminalToolBoundary = snap.terminalToolBoundary
    this.memoryWriteTerminalAllowed = snap.memoryWriteTerminalAllowed
    this.lastToolSummaryTextLen = snap.lastToolSummaryTextLen
  }

  /**
   * Append streamed text, handling the separator between tool output and new text.
   * Mutates fullText, lastSegment, and the provided iterationText wrapper.
   */
  appendText(text: string, iterationText: { value: string }, write: (data: string) => void): void {
    if (this.needsTextSeparator && this.fullText.length > 0) {
      this.fullText += '\n\n'
      iterationText.value += '\n\n'
      write(`data: ${JSON.stringify({ t: 'd', text: '\n\n' })}\n\n`)
      this.needsTextSeparator = false
    }
    this.fullText += text
    iterationText.value += text
    this.lastSegment += text
    write(`data: ${JSON.stringify({ t: 'd', text })}\n\n`)
  }

  /**
   * Settle the current segment: extract suggestions, update lastSettledSegment,
   * and reset lastSegment. Returns the cleaned settled text.
   */
  settleSegment(): string {
    const settled = extractSuggestions(this.lastSegment).clean.trim()
    if (settled) this.lastSettledSegment = settled
    this.lastSegment = ''
    return settled
  }
}
