import { notify } from '@/lib/server/ws-hub'
import { getSession, saveSession } from '@/lib/server/sessions/session-repository'
import { appendMessage } from '@/lib/server/messages/message-repository'
import type { MessageToolEvent, SSEEvent } from '@/types'
import type { ExecuteChatTurnResult } from './chat-execution-types'
import {
  resolveRequestedToolPreflightResponse,
  runExclusiveDirectMemoryPreflight,
} from '@/lib/server/chat-execution/chat-turn-tool-routing'
import {
  applyMessageLifecycleHooks,
  type PreparedBlockedChatTurn,
  type PreparedExecutableChatTurn,
} from '@/lib/server/chat-execution/chat-turn-preparation'

type DirectMemoryPreflightResult = Awaited<ReturnType<typeof runExclusiveDirectMemoryPreflight>>

export interface ChatTurnPreflightResult {
  terminalResult?: ExecuteChatTurnResult
  directMemoryResult?: DirectMemoryPreflightResult
}

async function completeSyntheticAssistantTurn(params: {
  runId?: string
  sessionId: string
  text: string
  lifecycleRunId: string
  enabledIds: string[]
  shouldPersist: boolean
  phase: 'assistant_final' | 'heartbeat'
  error?: string
  notifyMessages?: boolean
  notifySessions?: boolean
}): Promise<ExecuteChatTurnResult> {
  const session = getSession(params.sessionId)
  let persisted = false
  if (session && params.shouldPersist) {
    const nextAssistantMessage = await applyMessageLifecycleHooks({
      session,
      message: {
        role: 'assistant',
        text: params.text,
        time: Date.now(),
      },
      enabledIds: params.enabledIds,
      phase: params.phase,
      runId: params.lifecycleRunId,
      isSynthetic: true,
    })
    if (nextAssistantMessage) {
      appendMessage(params.sessionId, nextAssistantMessage)
      session.lastActiveAt = Date.now()
      saveSession(params.sessionId, session)
      if (params.notifyMessages) notify(`messages:${params.sessionId}`)
      if (params.notifySessions) notify('sessions')
      persisted = true
    }
  }

  return {
    runId: params.runId,
    sessionId: params.sessionId,
    text: params.text,
    persisted,
    toolEvents: [],
    error: params.error,
  }
}

export async function completeBlockedChatTurn(prepared: PreparedBlockedChatTurn): Promise<ExecuteChatTurnResult> {
  return completeSyntheticAssistantTurn({
    runId: prepared.runId,
    sessionId: prepared.sessionId,
    text: prepared.blockedMessage,
    lifecycleRunId: prepared.lifecycleRunId,
    enabledIds: prepared.syntheticEnabledIds,
    shouldPersist: !prepared.internal,
    phase: 'assistant_final',
    error: prepared.blockedMessage,
  })
}

export async function runChatTurnPreflight(params: {
  prepared: PreparedExecutableChatTurn
  emit: (event: SSEEvent) => void
  toolEvents: MessageToolEvent[]
}): Promise<ChatTurnPreflightResult | null> {
  const { prepared, emit, toolEvents } = params

  const requestedToolPreflightResponse = resolveRequestedToolPreflightResponse({
    message: prepared.message,
    enabledExtensions: prepared.extensionsForRun,
    toolPolicy: prepared.toolPolicy,
    appSettings: prepared.appSettings,
    internal: prepared.internal,
    source: prepared.source,
    session: prepared.sessionForRun,
  })
  if (requestedToolPreflightResponse) {
    return {
      terminalResult: await completeSyntheticAssistantTurn({
        runId: prepared.runId,
        sessionId: prepared.sessionId,
        text: requestedToolPreflightResponse,
        lifecycleRunId: prepared.lifecycleRunId,
        enabledIds: prepared.extensionsForRun,
        shouldPersist: !prepared.hideAssistantTranscript,
        phase: 'assistant_final',
        notifyMessages: true,
        notifySessions: true,
      }),
    }
  }

  const directMemoryResult = await runExclusiveDirectMemoryPreflight({
    session: prepared.sessionForRun,
    sessionId: prepared.sessionId,
    message: prepared.message,
    effectiveMessage: prepared.effectiveMessage,
    enabledExtensions: prepared.extensionsForRun,
    toolPolicy: prepared.toolPolicy,
    appSettings: prepared.appSettings,
    internal: prepared.internal,
    source: prepared.source,
    toolEvents,
    emit,
  })
  if (directMemoryResult) {
    return { directMemoryResult }
  }

  return null
}
