/**
 * Processes the LangGraph event stream for a single iteration of the
 * agent chat loop.  Handles on_chat_model_stream, on_llm_end,
 * on_tool_start, and on_tool_end events.
 */
import type { ChatTurnState } from '@/lib/server/chat-execution/chat-turn-state'
import type { IterationTimers } from '@/lib/server/chat-execution/iteration-timers'
import type { ToolLoopTracker } from '@/lib/server/tool-loop-detection'
import type { LangGraphToolEventTracker } from '@/lib/server/chat-execution/tool-event-tracker'
import type { Session } from '@/types'
import { canonicalizeExtensionId } from '@/lib/server/tool-aliases'
import { logExecution } from '@/lib/server/execution-log'
import { perf } from '@/lib/server/runtime/perf'
import {
  resolveSuccessfulTerminalToolBoundary,
  updateStreamedToolEvents,
} from '@/lib/server/chat-execution/chat-streaming-utils'
import {
  resolveToolAction,
} from '@/lib/server/chat-execution/memory-mutation-tools'
import {
  countExternalExecutionResearchSteps,
  countDistinctExternalResearchHosts,
} from '@/lib/server/chat-execution/stream-continuation'
import { truncateToolResultText, calculateMaxToolResultChars } from '@/lib/server/chat-execution/tool-result-guard'
import { notifyWithPayload } from '@/lib/server/ws-hub'
import { resolveExclusiveMemoryWriteTerminalAllowance } from '@/lib/server/chat-execution/chat-streaming-utils'
import { getContextWindowSize } from '@/lib/server/context-manager'

// ---------------------------------------------------------------------------
// LangGraph event kind constants
// ---------------------------------------------------------------------------

const EVENT_CHAT_MODEL_STREAM = 'on_chat_model_stream'
const EVENT_LLM_END = 'on_llm_end'
const EVENT_TOOL_START = 'on_tool_start'
const EVENT_TOOL_END = 'on_tool_end'

/** Token estimation: ~4 chars per token */
const CHARS_PER_TOKEN = 4

/** File operation tool names for enriched logging */
const FILE_OP_TOOLS = ['write_file', 'edit_file', 'copy_file', 'move_file', 'delete_file']

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IterationOutcome {
  reachedExecutionBoundary: boolean
  executionFollowthroughReason: 'research_limit' | 'post_simulation' | null
  loopBroken: boolean
  iterationText: string
  waitingForToolResult: boolean
}

export interface ProcessIterationEventsOpts {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventStream: AsyncIterable<any>
  state: ChatTurnState
  timers: IterationTimers
  loopTracker: ToolLoopTracker
  toolEventTracker: LangGraphToolEventTracker
  session: Session
  message: string
  write: (data: string) => void
  sessionExtensions: string[]
  boundedExternalExecutionTask: boolean
  toolToExtensionMap: Record<string, string>
  iterationController: AbortController
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function processIterationEvents(opts: ProcessIterationEventsOpts): Promise<IterationOutcome> {
  const {
    eventStream, state, timers, loopTracker, toolEventTracker,
    session, message, write, boundedExternalExecutionTask,
    toolToExtensionMap,
  } = opts

  let waitingForToolResult = false
  let reachedExecutionBoundary = false
  let executionFollowthroughReason: 'research_limit' | 'post_simulation' | null = null
  let loopBroken = false
  let toolEndCount = 0
  const iterationText = { value: '' }
  const toolPerfEnds = new Map<string, (extra?: Record<string, unknown>) => number>()

  /** Interval for progress checkpoint nudges */
  const PROGRESS_CHECK_INTERVAL = 10

  for await (const event of eventStream) {
    const kind = event.event

    if (kind === EVENT_CHAT_MODEL_STREAM) {
      timers.armIdleWatchdog(waitingForToolResult)
      const chunk = event.data?.chunk
      if (chunk?.content) {
        if (Array.isArray(chunk.content)) {
          for (const block of chunk.content) {
            if (block.type === 'thinking' && block.thinking) {
              state.accumulatedThinking += block.thinking
              write(`data: ${JSON.stringify({ t: 'thinking', text: block.thinking })}\n\n`)
            } else if (typeof block.text === 'string' && block.text.startsWith('[[thinking]]')) {
              state.accumulatedThinking += block.text.slice(12)
              write(`data: ${JSON.stringify({ t: 'thinking', text: block.text.slice(12) })}\n\n`)
            } else if (block.text) {
              state.appendText(block.text, iterationText, write)
            }
          }
        } else {
          const text = typeof chunk.content === 'string' ? chunk.content : ''
          if (text) {
            state.appendText(text, iterationText, write)
          }
        }
      }
    } else if (kind === EVENT_LLM_END) {
      timers.armIdleWatchdog(waitingForToolResult)
      const output = event.data?.output
      const usage = output?.llmOutput?.tokenUsage
        || output?.llmOutput?.usage
        || output?.usage_metadata
        || output?.response_metadata?.usage
        || output?.response_metadata?.tokenUsage
      if (usage) {
        state.totalInputTokens += usage.promptTokens || usage.input_tokens || usage.prompt_tokens || 0
        state.totalOutputTokens += usage.completionTokens || usage.output_tokens || usage.completion_tokens || 0
      }
    } else if (kind === EVENT_TOOL_START) {
      if (!toolEventTracker.acceptStart(event)) continue
      const toolName = event.name || 'unknown'
      const input = event.data?.input
      const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
      toolPerfEnds.set(event.run_id, perf.start('tool-call', toolName, { sessionId: session.id }))

      timers.clearIdleWatchdog()
      timers.clearRequiredToolKickoff()
      waitingForToolResult = true
      state.hasToolCalls = true
      state.needsTextSeparator = true
      state.settleSegment()
      state.usedToolNames.add(canonicalizeExtensionId(toolName) || toolName)
      // Shell-based HTTP satisfies research tool requirements
      if ((canonicalizeExtensionId(toolName) || toolName) === 'shell' && inputStr) {
        const cmdMatch = /curl|wget|http|gh\s+(issue|pr|api|repo|release|search|run)/.test(inputStr)
        if (cmdMatch) state.usedToolNames.add('web')
      }
      state.currentToolInputTokens = Math.ceil((inputStr?.length || 0) / CHARS_PER_TOKEN)
      logExecution(session.id, 'tool_call', `${toolName} invoked`, {
        agentId: session.agentId,
        detail: { toolName, input: inputStr?.slice(0, 4000) },
      })
      notifyWithPayload(`session:${session.id}:execution`, {
        event: 'tool_start',
        toolName,
        toolCallId: event.run_id,
        timestamp: Date.now(),
      })
      write(`data: ${JSON.stringify({
        t: 'tool_call',
        toolName,
        toolInput: inputStr,
        toolCallId: event.run_id,
      })}\n\n`)
      updateStreamedToolEvents(state.streamedToolEvents, {
        type: 'call',
        name: toolName,
        input: inputStr,
        toolCallId: event.run_id,
      })
    } else if (kind === EVENT_TOOL_END) {
      if (!toolEventTracker.complete(event.run_id)) continue
      const endToolPerf = toolPerfEnds.get(event.run_id)
      toolPerfEnds.delete(event.run_id)

      waitingForToolResult = toolEventTracker.pendingCount > 0
      if (!waitingForToolResult) timers.armIdleWatchdog(false)
      const toolName = event.name || 'unknown'
      const output = event.data?.output
      const rawOutputStr = typeof output === 'string'
        ? output
        : output?.content
          ? String(output.content)
          : JSON.stringify(output)
      // Apply tool result size guard
      const maxResultChars = calculateMaxToolResultChars(getContextWindowSize(session.provider, session.model))
      const outputStr = truncateToolResultText(rawOutputStr, maxResultChars)
      logExecution(session.id, 'tool_result', `${toolName} returned`, {
        agentId: session.agentId,
        detail: { toolName, output: outputStr?.slice(0, 4000), error: /^(Error:|error:)/i.test((outputStr || '').trim()) || undefined },
      })
      notifyWithPayload(`session:${session.id}:execution`, {
        event: 'tool_end',
        toolName,
        toolCallId: event.run_id,
        hasError: /^(Error:|error:)/i.test((outputStr || '').trim()),
        timestamp: Date.now(),
      })
      // Enriched file_op logging
      if (FILE_OP_TOOLS.includes(toolName)) {
        const inputData = event.data?.input
        const inputObj = typeof inputData === 'object' ? inputData : {}
        logExecution(session.id, 'file_op', `${toolName}: ${inputObj?.filePath || inputObj?.sourcePath || 'unknown'}`, {
          agentId: session.agentId,
          detail: { toolName, filePath: inputObj?.filePath, sourcePath: inputObj?.sourcePath, destinationPath: inputObj?.destinationPath, success: !/^Error/i.test((outputStr || '').trim()) },
        })
      }
      // Enriched commit logging
      if (toolName === 'execute_command' && outputStr) {
        const commitMatch = outputStr.match(/\[[\w/-]+\s+([a-f0-9]{7,40})\]/)
        if (commitMatch) {
          logExecution(session.id, 'commit', `git commit ${commitMatch[1]}`, {
            agentId: session.agentId,
            detail: { commitId: commitMatch[1], outputPreview: outputStr.slice(0, 500) },
          })
        }
      }
      // Track extension invocation token estimates
      const extensionId = toolToExtensionMap[toolName] || '_unknown'
      state.extensionInvocations.push({
        extensionId,
        toolName,
        inputTokens: state.currentToolInputTokens,
        outputTokens: Math.ceil((outputStr?.length || 0) / CHARS_PER_TOKEN),
      })
      state.currentToolInputTokens = 0

      // --- Tool loop detection ---
      const loopResult = loopTracker.record(toolName, event.data?.input, output)
      if (loopResult) {
        logExecution(session.id, 'loop_detection', loopResult.message, {
          agentId: session.agentId,
          detail: { detector: loopResult.detector, severity: loopResult.severity, toolName },
        })
        if (loopResult.severity === 'critical') {
          state.loopDetectionTriggered = loopResult
          write(`data: ${JSON.stringify({ t: 'status', text: JSON.stringify({ loopDetection: loopResult.detector, severity: 'critical', message: loopResult.message }) })}\n\n`)
          loopBroken = true
          break
        }
        if (loopResult.severity === 'warning') {
          write(`data: ${JSON.stringify({ t: 'status', text: JSON.stringify({ loopDetection: loopResult.detector, severity: 'warning', message: loopResult.message }) })}\n\n`)
        }
      }

      // --- Progress checkpoint ---
      toolEndCount++
      if (toolEndCount > 0 && toolEndCount % PROGRESS_CHECK_INTERVAL === 0) {
        const nudge = `Progress check (${toolEndCount} tool calls this iteration). Are you on track for: "${message.slice(0, 200)}"? If stuck, deliver what you have.`
        write(`data: ${JSON.stringify({ t: 'status', text: JSON.stringify({ progressCheck: true, toolCallCount: toolEndCount, message: nudge }) })}\n\n`)
        logExecution(session.id, 'decision', nudge, {
          agentId: session.agentId,
          detail: { toolEndCount },
        })
      }

      endToolPerf?.({ outputLen: outputStr?.length || 0 })
      write(`data: ${JSON.stringify({
        t: 'tool_result',
        toolName,
        toolOutput: outputStr?.slice(0, 2000),
        toolCallId: event.run_id,
      })}\n\n`)
      updateStreamedToolEvents(state.streamedToolEvents, {
        type: 'result',
        name: toolName,
        output: outputStr,
        toolCallId: event.run_id,
      })
      const toolBoundary = resolveSuccessfulTerminalToolBoundary({
        toolName,
        toolInput: event.data?.input,
        toolOutput: outputStr || '',
        allowMemoryWriteTerminal: state.terminalToolBoundary === 'memory_write' ? state.memoryWriteTerminalAllowed !== false : undefined,
      })
      if (toolBoundary) {
        if (toolBoundary.kind === 'memory_write') {
          if (state.memoryWriteTerminalAllowed === null) {
            state.memoryWriteTerminalAllowed = await resolveExclusiveMemoryWriteTerminalAllowance({
              sessionId: session.id,
              agentId: session.agentId || null,
              message,
            })
          }
          if (!state.memoryWriteTerminalAllowed) {
            logExecution(session.id, 'decision', 'Successful memory write treated as intermediate evidence; continuing the turn.', {
              agentId: session.agentId,
              detail: { toolName, action: resolveToolAction(event.data?.input) || null, boundary: toolBoundary.kind },
            })
            continue
          }
          const naturalResponse = (toolBoundary.responseText || '').trim() || 'I\'ll remember that.'
          state.fullText = naturalResponse
          iterationText.value = naturalResponse
          state.lastSegment = naturalResponse
          state.lastSettledSegment = naturalResponse
          state.needsTextSeparator = false
          state.terminalToolBoundary = toolBoundary.kind
          state.terminalToolResponse = naturalResponse
          logExecution(session.id, 'decision', 'Successful memory write completed; finalizing with a single acknowledgement.', {
            agentId: session.agentId,
            detail: { toolName, action: resolveToolAction(event.data?.input) || null, boundary: toolBoundary.kind, responseText: naturalResponse },
          })
          write(`data: ${JSON.stringify({ t: 'r', text: naturalResponse })}\n\n`)
          write(`data: ${JSON.stringify({
            t: 'status',
            text: JSON.stringify({ terminalToolResult: toolBoundary.kind }),
          })}\n\n`)
          break
        } else {
          state.terminalToolBoundary = toolBoundary.kind
          state.terminalToolResponse = ''
          logExecution(session.id, 'decision', `Terminal tool boundary reached: ${toolBoundary.kind}.`, {
            agentId: session.agentId,
            detail: { toolName, action: resolveToolAction(event.data?.input) || null, boundary: toolBoundary.kind },
          })
          write(`data: ${JSON.stringify({
            t: 'status',
            text: JSON.stringify({ terminalToolResult: toolBoundary.kind }),
          })}\n\n`)
          break
        }
      }
      if (
        boundedExternalExecutionTask
        && ['http_request', 'web', 'web_search', 'web_fetch', 'browser'].includes(toolName)
        && countExternalExecutionResearchSteps(state.streamedToolEvents) >= 5
        && countDistinctExternalResearchHosts(state.streamedToolEvents) >= 3
      ) {
        executionFollowthroughReason = 'research_limit'
        write(`data: ${JSON.stringify({
          t: 'status',
          text: JSON.stringify({ executionBoundary: 'research_limit' }),
        })}\n\n`)
        break
      }
    }
  }

  return {
    reachedExecutionBoundary,
    executionFollowthroughReason,
    loopBroken,
    iterationText: iterationText.value,
    waitingForToolResult,
  }
}
