/**
 * Post-loop finalization for a streamed agent chat turn.
 *
 * Handles suggestion extraction, thinking metadata, cost tracking,
 * usage recording, forced external service summary, capability hooks,
 * and OpenClaw sync.
 */
import type { KnowledgeRetrievalTrace, Session, UsageRecord } from '@/types'
import { log } from '@/lib/server/logger'
import type { ChatTurnState } from '@/lib/server/chat-execution/chat-turn-state'

const TAG = 'post-stream'
import { extractSuggestions } from '@/lib/server/suggestions'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { estimateCost, buildExtensionDefinitionCosts } from '@/lib/server/cost'
import { appendUsage } from '@/lib/server/usage/usage-repository'
import { runCapabilityHook } from '@/lib/server/native-capabilities'
import {
  shouldForceExternalServiceSummary,
} from '@/lib/server/chat-execution/chat-streaming-utils'
import type { MessageClassification } from '@/lib/server/chat-execution/message-classifier'
import {
  resolveFinalStreamResponseText,
} from '@/lib/server/chat-execution/stream-continuation'
import { buildForcedExternalServiceSummary } from '@/lib/server/chat-execution/prompt-builder'

// ---------------------------------------------------------------------------
// Classification JSON leak detection — strips `{ "isDeliverableTask": ... }`
// objects that some models echo verbatim into their response text.
// ---------------------------------------------------------------------------

const CLASSIFICATION_LEAK_RE = /\{\s*"isDeliverableTask"\s*:/

function stripLeakedClassificationJson(text: string): { cleaned: string; stripped: boolean } {
  const match = CLASSIFICATION_LEAK_RE.exec(text)
  if (!match || match.index === undefined) return { cleaned: text, stripped: false }
  const startIdx = match.index
  let depth = 0
  let end = -1
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  if (end === -1) return { cleaned: text, stripped: false }
  log.warn(TAG, 'Stripped leaked classification JSON from model output')
  return { cleaned: (text.slice(0, startIdx) + text.slice(end)).trimStart(), stripped: true }
}

// StreamAgentChatResult is defined inline to avoid circular dependency with stream-agent-chat.ts
export interface PostStreamResult {
  fullText: string
  finalResponse: string
  toolEvents: import('@/types').MessageToolEvent[]
  knowledgeRetrievalTrace?: KnowledgeRetrievalTrace | null
}

export interface FinalizeStreamResultOpts {
  state: ChatTurnState
  session: Session
  message: string
  write: (data: string) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  llm: { invoke: (messages: any[]) => Promise<{ content: unknown }> }
  prompt: string
  tools: StructuredToolInterface[]
  toolToExtensionMap: Record<string, string>
  history: import('@/types').Message[]
  sessionExtensions: string[]
  startTs: number
  signal?: AbortSignal
  cleanup: () => Promise<void>
  runId: string
  classification?: MessageClassification | null
  knowledgeRetrievalTrace?: KnowledgeRetrievalTrace | null
}

export async function finalizeStreamResult(opts: FinalizeStreamResultOpts): Promise<PostStreamResult> {
  const {
    state, session, message, write, llm, prompt, tools,
    toolToExtensionMap, history, sessionExtensions, startTs,
    signal, cleanup, runId,
  } = opts

  const emitLlmOutputHook = async (response: string) => {
    const total = state.totalInputTokens + state.totalOutputTokens
    await runCapabilityHook(
      'llmOutput',
      {
        session,
        runId,
        provider: session.provider,
        model: session.model,
        assistantTexts: response ? [response] : [],
        response,
        usage: total > 0
          ? {
              input: state.totalInputTokens,
              output: state.totalOutputTokens,
              total,
              estimatedCost: estimateCost(session.model, state.totalInputTokens, state.totalOutputTokens),
            }
          : undefined,
      },
      { enabledIds: sessionExtensions },
    )
  }

  /** Resolve final response and apply forced external service summary if needed. */
  const resolveAndSummarize = async (): Promise<string> => {
    let finalResponse = resolveFinalStreamResponseText({
      fullText: state.fullText,
      lastSegment: state.lastSegment,
      lastSettledSegment: state.lastSettledSegment,
      hasToolCalls: state.hasToolCalls,
      toolEvents: state.streamedToolEvents,
    })
    if (shouldForceExternalServiceSummary({
      userMessage: message,
      finalResponse,
      hasToolCalls: state.hasToolCalls,
      toolEventCount: state.streamedToolEvents.length,
      classification: opts.classification,
    })) {
      const forcedSummary = await buildForcedExternalServiceSummary({
        llm,
        userMessage: message,
        fullText: state.fullText,
        toolEvents: state.streamedToolEvents,
      })
      if (forcedSummary) {
        state.fullText = state.fullText.trim() ? `${state.fullText.trim()}\n\n${forcedSummary}` : forcedSummary
        finalResponse = forcedSummary
      }
    }
    return finalResponse
  }

  // Skip post-stream work if the client disconnected mid-stream
  if (signal?.aborted) {
    const finalResponse = await resolveAndSummarize()
    await emitLlmOutputHook(finalResponse)
    await cleanup()
    return {
      fullText: state.fullText,
      finalResponse,
      toolEvents: state.streamedToolEvents,
      knowledgeRetrievalTrace: opts.knowledgeRetrievalTrace || null,
    }
  }

  // Strip leaked classification JSON from model output (e.g. `{ "isDeliverableTask": true, ... }`)
  const leakResult = stripLeakedClassificationJson(state.fullText)
  if (leakResult.stripped) {
    state.fullText = leakResult.cleaned
    // Emit a reset so the frontend re-renders with the cleaned text
    write(`data: ${JSON.stringify({ t: 'reset', text: leakResult.cleaned })}\n\n`)
  }

  // Extract LLM-generated suggestions from the response and strip the tag
  const extracted = extractSuggestions(state.fullText)
  state.fullText = extracted.clean
  if (!state.fullText.trim() && state.terminalToolResponse) state.fullText = state.terminalToolResponse
  if (extracted.suggestions) {
    write(`data: ${JSON.stringify({ t: 'md', text: JSON.stringify({ suggestions: extracted.suggestions }) })}\n\n`)
  }

  // Emit full thinking text as metadata
  if (state.accumulatedThinking) {
    write(`data: ${JSON.stringify({ t: 'md', text: JSON.stringify({ thinking: state.accumulatedThinking }) })}\n\n`)
  }

  // Track cost — fall back to character-count estimation
  if (state.totalInputTokens === 0 && state.totalOutputTokens === 0 && state.fullText) {
    const historyText = history.map((m) => m.text || '').join('')
    state.totalInputTokens = Math.ceil((message.length + historyText.length + prompt.length) / 4)
    state.totalOutputTokens = Math.ceil(state.fullText.length / 4)
  }
  const totalTokens = state.totalInputTokens + state.totalOutputTokens
  if (totalTokens > 0) {
    const cost = estimateCost(session.model, state.totalInputTokens, state.totalOutputTokens)
    const extensionDefinitionCosts = buildExtensionDefinitionCosts(tools, toolToExtensionMap)
    const usageRecord: UsageRecord = {
      sessionId: session.id,
      messageIndex: history.length,
      model: session.model,
      provider: session.provider,
      inputTokens: state.totalInputTokens,
      outputTokens: state.totalOutputTokens,
      totalTokens,
      estimatedCost: cost,
      timestamp: Date.now(),
      durationMs: Date.now() - startTs,
      agentId: session.agentId || null,
      projectId: session.projectId || null,
      extensionDefinitionCosts,
      extensionInvocations: state.extensionInvocations.length > 0 ? state.extensionInvocations : undefined,
    }
    appendUsage(session.id, usageRecord)
    write(`data: ${JSON.stringify({
      t: 'md',
      text: JSON.stringify({ usage: { inputTokens: state.totalInputTokens, outputTokens: state.totalOutputTokens, totalTokens, estimatedCost: cost } }),
    })}\n\n`)
  }

  const finalResponse = await resolveAndSummarize()

  await emitLlmOutputHook(finalResponse)

  await runCapabilityHook('afterAgentComplete', { session, response: state.fullText }, { enabledIds: sessionExtensions })

  // OpenClaw auto-sync
  try {
    const { loadSyncConfig, pushMemoryToOpenClaw } = await import('@/lib/server/openclaw/sync')
    const syncConfig = loadSyncConfig()
    if (syncConfig.autoSyncMemory) {
      pushMemoryToOpenClaw(session.agentId || undefined)
    }
  } catch { /* OpenClaw sync not available — ignore */ }

  await cleanup()

  return {
    fullText: state.fullText,
    finalResponse,
    toolEvents: state.streamedToolEvents,
    knowledgeRetrievalTrace: opts.knowledgeRetrievalTrace || null,
  }
}
