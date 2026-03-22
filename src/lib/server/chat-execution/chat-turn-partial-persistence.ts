import {
  getSession,
} from '@/lib/server/sessions/session-repository'
import { getMessages, replaceAllMessages } from '@/lib/server/messages/message-repository'
import { notify } from '@/lib/server/ws-hub'
import type { MessageToolEvent, SSEEvent } from '@/types'
import { upsertStreamingAssistantArtifact } from '@/lib/chat/chat-streaming-state'
import { pruneIncompleteToolEvents } from '@/lib/server/chat-execution/chat-streaming-utils'
import {
  collectToolEvent,
  dedupeConsecutiveToolEvents,
  extractEventJson,
} from '@/lib/server/chat-execution/chat-execution-tool-events'
import {
  getToolEventsSnapshotKey,
  hasPersistableAssistantPayload,
} from '@/lib/server/chat-execution/chat-execution-utils'
import {
  applyMessageLifecycleHooks,
  type PreparedExecutableChatTurn,
} from '@/lib/server/chat-execution/chat-turn-preparation'

export interface PartialAssistantSnapshot {
  thinkingText: string
  toolEvents: MessageToolEvent[]
  streamErrors: string[]
  accumulatedUsage: {
    inputTokens: number
    outputTokens: number
    estimatedCost: number
  }
}

export interface PartialAssistantPersistence {
  emit: (event: SSEEvent) => void
  parseAndEmit: (raw: string) => void
  stop: () => void
  awaitIdle: () => Promise<void>
  getToolEvents: () => MessageToolEvent[]
  getSnapshot: () => PartialAssistantSnapshot
}

const PARTIAL_SAVE_INTERVAL_MS = 3500
const PARTIAL_SAVE_MIN_INTERVAL_MS = 400

export function createPartialAssistantPersistence(input: {
  prepared: PreparedExecutableChatTurn
  onEvent?: (event: SSEEvent) => void
}): PartialAssistantPersistence {
  const { prepared, onEvent } = input
  const toolEvents: MessageToolEvent[] = []
  const streamErrors: string[] = []
  const accumulatedUsage = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 }

  let thinkingText = ''
  let streamingPartialText = ''
  let lastPartialSaveAt = 0
  let lastPartialSnapshotKey = ''
  let partialSaveTimeout: ReturnType<typeof setTimeout> | null = null
  let partialPersistenceClosed = false
  let partialPersistChain: Promise<void> = Promise.resolve()

  const persistStreamingAssistantArtifact = async () => {
    if (prepared.hideAssistantTranscript) return
    partialSaveTimeout = null
    if (partialPersistenceClosed) return
    const persistedToolEvents = toolEvents.length
      ? dedupeConsecutiveToolEvents(pruneIncompleteToolEvents([...toolEvents]))
      : []
    if (!hasPersistableAssistantPayload(streamingPartialText, thinkingText, persistedToolEvents)) return

    try {
      const current = getSession(prepared.sessionId)
      if (!current) return
      const currentMessages = getMessages(prepared.sessionId)
      const partialMsg = await applyMessageLifecycleHooks({
        session: current,
        message: {
          role: 'assistant',
          text: streamingPartialText,
          time: Date.now(),
          streaming: true,
          runId: prepared.lifecycleRunId,
          thinking: thinkingText || undefined,
          toolEvents: persistedToolEvents.length ? persistedToolEvents : undefined,
        },
        enabledIds: prepared.extensionsForRun,
        phase: 'assistant_partial',
        runId: prepared.lifecycleRunId,
        isSynthetic: true,
      })
      if (!partialMsg) return
      const snapshotKey = JSON.stringify([
        partialMsg.text,
        partialMsg.thinking || '',
        getToolEventsSnapshotKey(partialMsg.toolEvents || []),
      ])
      if (snapshotKey === lastPartialSnapshotKey) return
      lastPartialSnapshotKey = snapshotKey
      lastPartialSaveAt = Date.now()
      upsertStreamingAssistantArtifact(currentMessages, partialMsg, {
        minIndex: prepared.runMessageStartIndex,
        minTime: prepared.runStartedAt,
      })
      replaceAllMessages(prepared.sessionId, currentMessages)
      notify(`messages:${prepared.sessionId}`)
    } catch {
      // Partial persistence is best-effort.
    }
  }

  const triggerPartialAssistantPersist = () => {
    partialPersistChain = partialPersistChain
      .catch(() => {})
      .then(async () => {
        await persistStreamingAssistantArtifact()
      })
  }

  const queuePartialAssistantPersist = (immediate = false) => {
    if (partialPersistenceClosed) return
    const now = Date.now()
    if (immediate || now - lastPartialSaveAt >= PARTIAL_SAVE_MIN_INTERVAL_MS) {
      if (partialSaveTimeout) {
        clearTimeout(partialSaveTimeout)
        partialSaveTimeout = null
      }
      triggerPartialAssistantPersist()
      return
    }
    if (partialSaveTimeout) return
    partialSaveTimeout = setTimeout(() => {
      triggerPartialAssistantPersist()
    }, PARTIAL_SAVE_MIN_INTERVAL_MS - (now - lastPartialSaveAt))
  }

  const emit = (event: SSEEvent) => {
    let shouldPersistPartial = false
    let immediatePartialPersist = false
    if (event.t === 'reset') {
      streamingPartialText = event.text || ''
      thinkingText = ''
      toolEvents.length = 0
      shouldPersistPartial = true
      immediatePartialPersist = true
    }
    if (event.t === 'd' && typeof event.text === 'string') {
      streamingPartialText += event.text
      shouldPersistPartial = true
      immediatePartialPersist = streamingPartialText.length === event.text.length
    }
    if (event.t === 'err' && typeof event.text === 'string') {
      const trimmed = event.text.trim()
      if (trimmed) {
        streamErrors.push(trimmed)
        if (streamErrors.length > 8) streamErrors.shift()
      }
    }
    if (event.t === 'thinking' && event.text) {
      thinkingText += event.text
      shouldPersistPartial = true
    }
    if (event.t === 'md' && event.text) {
      try {
        const mdPayload = JSON.parse(event.text) as Record<string, unknown>
        const usage = mdPayload.usage as { inputTokens?: number; outputTokens?: number; estimatedCost?: number } | undefined
        if (usage) {
          if (typeof usage.inputTokens === 'number') accumulatedUsage.inputTokens += usage.inputTokens
          if (typeof usage.outputTokens === 'number') accumulatedUsage.outputTokens += usage.outputTokens
          if (typeof usage.estimatedCost === 'number') accumulatedUsage.estimatedCost += usage.estimatedCost
        }
      } catch {
        // Ignore non-JSON md events.
      }
    }
    collectToolEvent(event, toolEvents)
    if (event.t === 'tool_call' || event.t === 'tool_result') {
      shouldPersistPartial = true
      immediatePartialPersist = true
    }
    if (shouldPersistPartial) queuePartialAssistantPersist(immediatePartialPersist)
    onEvent?.(event)
  }

  const periodicTimer = setInterval(() => {
    persistStreamingAssistantArtifact()
  }, PARTIAL_SAVE_INTERVAL_MS)

  return {
    emit,
    parseAndEmit(raw: string) {
      const lines = raw.split('\n').filter(Boolean)
      for (const line of lines) {
        const event = extractEventJson(line)
        if (event) emit(event)
      }
    },
    stop() {
      partialPersistenceClosed = true
      if (partialSaveTimeout) {
        clearTimeout(partialSaveTimeout)
        partialSaveTimeout = null
      }
      clearInterval(periodicTimer)
    },
    awaitIdle() {
      return partialPersistChain.catch(() => {})
    },
    getToolEvents() {
      return toolEvents
    },
    getSnapshot() {
      return {
        thinkingText,
        toolEvents: [...toolEvents],
        streamErrors: [...streamErrors],
        accumulatedUsage: { ...accumulatedUsage },
      }
    },
  }
}
