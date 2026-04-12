/**
 * Evaluates whether the agent loop should continue after an iteration
 * and which continuation type applies.  Each check is a named function
 * walked in priority order.
 *
 * Consolidated from 13 → 9 checks by merging overlapping execution and
 * shell-fallback logic.
 */
import type { Message } from '@/types'
import type { ContinuationType } from '@/lib/server/chat-execution/stream-continuation'
import type { ChatTurnState } from '@/lib/server/chat-execution/chat-turn-state'
import type { ContinuationLimits } from '@/lib/server/chat-execution/continuation-limits'
import type { LangGraphToolEventTracker } from '@/lib/server/chat-execution/tool-event-tracker'
import type { MessageClassification } from '@/lib/server/chat-execution/message-classifier'
import { isDeliverableTask as classifiedIsDeliverableTask } from '@/lib/server/chat-execution/message-classifier'
import { canonicalizeExtensionId } from '@/lib/server/tool-aliases'
import {
  shouldForceRecoverableToolErrorFollowthrough,
  shouldForceWorkspaceScopeShellFallback,
  shouldForceExternalExecutionKickoffFollowthrough,
  shouldForceExternalExecutionFollowthrough,
  shouldForceDeliverableFollowthrough,
  hasIncompleteDelegationWait,
  resolveFinalStreamResponseText,
} from '@/lib/server/chat-execution/stream-continuation'
import {
  hasOnlySuccessfulMemoryMutationToolEvents,
} from '@/lib/server/chat-execution/memory-mutation-tools'
import { shouldForceAttachmentFollowthrough } from '@/lib/server/chat-execution/prompt-builder'
import { shouldSkipToolSummaryForShortResponse } from '@/lib/server/chat-execution/chat-streaming-utils'
import { toolSummaryHasMeaningfulProgress } from '@/lib/server/chat-execution/tool-summary-progress'
import { logExecution, type LogCategory } from '@/lib/server/execution-log'

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ContinuationContext {
  state: ChatTurnState
  limits: ContinuationLimits
  toolEventTracker: LangGraphToolEventTracker
  message: string
  sessionExtensions: string[]
  isConnectorSession: boolean
  isCoordinatorAgent: boolean
  delegationEnabled: boolean
  delegationPreferenceActive: boolean
  history: Message[]
  session: { cwd: string }
  write: (data: string) => void
  explicitRequiredToolNames: string[]
  hasAttachmentContext: boolean
  executionFollowthroughReason: 'research_limit' | 'post_simulation' | null
  likelyResearchSynthesisTask: boolean
  abortControllerAborted: boolean
  classification: MessageClassification | null
}

export interface ContinuationDecision {
  type: ContinuationType
  requiredToolReminderNames: string[]
  frequencyLimitedToolName?: string
}

// ---------------------------------------------------------------------------
// SSE status helper — eliminates the duplicated write pattern
// ---------------------------------------------------------------------------

function writeStatus(ctx: ContinuationContext, payload: Record<string, unknown>): void {
  ctx.write(`data: ${JSON.stringify({ t: 'status', text: JSON.stringify(payload) })}\n\n`)
}

// ---------------------------------------------------------------------------
// Individual checks (order-dependent — same priority as original)
// ---------------------------------------------------------------------------

function resolveCurrentFinalResponse(state: ChatTurnState): string {
  return resolveFinalStreamResponseText({
    fullText: state.fullText,
    lastSegment: state.lastSegment,
    lastSettledSegment: state.lastSettledSegment,
    hasToolCalls: state.hasToolCalls,
    toolEvents: state.streamedToolEvents,
  })
}

/**
 * Unfinished tool calls — delegates deliverable detection to checkDeliverableFollowthrough
 * rather than duplicating the deliverable branch here.
 */
function checkUnfinishedToolCallsPending(ctx: ContinuationContext): ContinuationDecision | null {
  if (ctx.toolEventTracker.pendingCount === 0 || ctx.abortControllerAborted) return null
  if (ctx.limits.canContinue('unfinished_tool_followthrough')) {
    const count = ctx.limits.increment('unfinished_tool_followthrough')
    const { max } = ctx.limits.getStatus('unfinished_tool_followthrough')
    writeStatus(ctx, {
      unfinishedToolFollowthrough: count,
      maxFollowthroughs: max,
      pendingToolCallIds: ctx.toolEventTracker.listPendingRunIds(),
    })
    return { type: 'unfinished_tool_followthrough', requiredToolReminderNames: [] }
  }
  return null
}

function checkLightweightDirectChat(ctx: ContinuationContext): ContinuationDecision | null {
  if (ctx.classification?.isLightweightDirectChat !== true) return null
  if (!ctx.state.fullText.trim()) return null
  if (ctx.state.hasToolCalls || ctx.state.streamedToolEvents.length > 0) return null
  return { type: false, requiredToolReminderNames: [] }
}

function checkLoopDetection(ctx: ContinuationContext): ContinuationDecision | null {
  const isToolFrequency = (ctx.state.loopDetectionTriggered?.detector === 'tool_frequency') || ctx.state.toolFrequencyBlocked
  if (!ctx.state.loopDetectionTriggered && !isToolFrequency) return null

  // Tool frequency is recoverable — the agent is doing diverse work with one tool.
  // Allow continuation with a fresh budget if loop_recovery has remaining uses.
  if (isToolFrequency && ctx.limits.canContinue('loop_recovery')) {
    // Extract tool name from whichever path triggered the frequency block
    const frequencyLimitedToolName = ctx.state.loopDetectionTriggered?.toolName
      || (typeof ctx.state.toolFrequencyBlocked === 'string' ? ctx.state.toolFrequencyBlocked : undefined)
    const count = ctx.limits.increment('loop_recovery')
    const { max } = ctx.limits.getStatus('loop_recovery')
    writeStatus(ctx, {
      loopRecovery: count,
      maxRecoveries: max,
      detector: 'tool_frequency',
      toolName: frequencyLimitedToolName,
    })
    ctx.state.loopDetectionTriggered = null
    ctx.state.toolFrequencyBlocked = false
    return { type: 'loop_recovery', requiredToolReminderNames: [], frequencyLimitedToolName }
  }

  // Non-frequency detectors (or exhausted budget) — check for tool_summary override
  if (ctx.state.loopDetectionTriggered) {
    const skipToolSummaryForShortResponse = shouldSkipToolSummaryForShortResponse({
      fullText: ctx.state.fullText,
      toolEvents: ctx.state.streamedToolEvents,
      isConnectorSession: ctx.isConnectorSession,
    })
    const loopTextIsTrivial = !ctx.state.fullText.trim() || (
      !skipToolSummaryForShortResponse
      && ctx.state.fullText.trim().length < 150
      && ctx.state.streamedToolEvents.length >= 2
    )
    if (loopTextIsTrivial && ctx.state.streamedToolEvents.length > 0 && ctx.limits.canContinue('tool_summary')) {
      // Override: let tool_summary handle it
      ctx.state.loopDetectionTriggered = null
      ctx.state.toolFrequencyBlocked = false
      return null
    }
  }

  // Terminal — caller should break.
  // Emit a user-friendly message instead of the raw diagnostic (which is internal).
  // The structured diagnostic data is already carried via the `status` event in iteration-event-handler.
  ctx.write(`data: ${JSON.stringify({ t: 'err', text: 'The agent got stuck in a repetitive loop and has been stopped. Please try rephrasing your request or breaking it into smaller steps.' })}\n\n`)
  return { type: false, requiredToolReminderNames: [] }
}

/**
 * Consolidated execution continuation check.
 * Merges the former checkExecutionFollowthrough (reason-based),
 * checkExecutionKickoff, and checkExternalExecutionFollowthrough into one.
 */
function checkExecutionContinuation(ctx: ContinuationContext): ContinuationDecision | null {
  // 1. Explicit reason from caller (e.g. research_limit, post_simulation)
  if (ctx.executionFollowthroughReason) {
    if (!ctx.limits.canContinue('execution_followthrough')) return null
    const count = ctx.limits.increment('execution_followthrough')
    const { max } = ctx.limits.getStatus('execution_followthrough')
    writeStatus(ctx, {
      externalExecutionFollowthrough: count,
      maxFollowthroughs: max,
      reason: ctx.executionFollowthroughReason,
    })
    return { type: 'execution_followthrough', requiredToolReminderNames: [] }
  }

  const finalResponse = resolveCurrentFinalResponse(ctx.state)

  // 2. Execution kickoff (agent described what it will do but didn't start)
  if (ctx.limits.canContinue('execution_kickoff_followthrough')) {
    if (shouldForceExternalExecutionKickoffFollowthrough({
      userMessage: ctx.message,
      finalResponse,
      hasToolCalls: ctx.state.hasToolCalls,
      toolEvents: ctx.state.streamedToolEvents,
      classification: ctx.classification,
    })) {
      const count = ctx.limits.increment('execution_kickoff_followthrough')
      const { max } = ctx.limits.getStatus('execution_kickoff_followthrough')
      writeStatus(ctx, {
        externalExecutionKickoff: count,
        maxFollowthroughs: max,
      })
      return { type: 'execution_kickoff_followthrough', requiredToolReminderNames: [] }
    }
  }

  // 3. External execution followthrough (agent started but didn't finish)
  if (ctx.limits.canContinue('execution_followthrough')) {
    if (shouldForceExternalExecutionFollowthrough({
      userMessage: ctx.message,
      finalResponse,
      hasToolCalls: ctx.state.hasToolCalls,
      toolEvents: ctx.state.streamedToolEvents,
      classification: ctx.classification,
    })) {
      const count = ctx.limits.increment('execution_followthrough')
      const { max } = ctx.limits.getStatus('execution_followthrough')
      writeStatus(ctx, {
        externalExecutionFollowthrough: count,
        maxFollowthroughs: max,
      })
      return { type: 'execution_followthrough', requiredToolReminderNames: [] }
    }
  }

  return null
}

/**
 * Required tools + workspace shell fallback (merged).
 * Shell fallback is just a special case of "required tool not yet used."
 */
function checkRequiredTools(ctx: ContinuationContext): ContinuationDecision | null {
  if (!ctx.limits.canContinue('required_tool')) return null

  // Explicit required tools
  if (ctx.explicitRequiredToolNames.length > 0) {
    const reminderNames = ctx.explicitRequiredToolNames.filter((toolName) => {
      const canonical = canonicalizeExtensionId(toolName) || toolName
      return !ctx.state.usedToolNames.has(toolName) && !ctx.state.usedToolNames.has(canonical)
    })
    if (reminderNames.length > 0) {
      const count = ctx.limits.increment('required_tool')
      const { max } = ctx.limits.getStatus('required_tool')
      writeStatus(ctx, {
        requiredToolsPending: reminderNames,
        reminderCount: count,
        maxReminders: max,
      })
      return { type: 'required_tool', requiredToolReminderNames: reminderNames }
    }
  }

  // Workspace shell fallback — agent should have used shell but didn't
  if (shouldForceWorkspaceScopeShellFallback({
    userMessage: ctx.message,
    finalResponse: resolveCurrentFinalResponse(ctx.state),
    toolEvents: ctx.state.streamedToolEvents,
    enabledExtensions: ctx.sessionExtensions,
  })) {
    const count = ctx.limits.increment('required_tool')
    const { max } = ctx.limits.getStatus('required_tool')
    writeStatus(ctx, {
      requiredToolsPending: ['shell'],
      reminderCount: count,
      maxReminders: max,
      reason: 'workspace_scope_shell_fallback',
    })
    return { type: 'required_tool', requiredToolReminderNames: ['shell'] }
  }

  return null
}

function checkMemoryWriteFollowthrough(ctx: ContinuationContext): ContinuationDecision | null {
  if (ctx.state.fullText.trim()) return null
  if (!hasOnlySuccessfulMemoryMutationToolEvents(ctx.state.streamedToolEvents)) return null
  if (!ctx.limits.canContinue('memory_write_followthrough')) return null
  const count = ctx.limits.increment('memory_write_followthrough')
  const { max } = ctx.limits.getStatus('memory_write_followthrough')
  writeStatus(ctx, {
    memoryWriteFollowthrough: count,
    maxFollowthroughs: max,
    reason: 'empty_reply_after_memory_write',
  })
  return { type: 'memory_write_followthrough', requiredToolReminderNames: [] }
}

function checkAttachmentFollowthrough(ctx: ContinuationContext): ContinuationDecision | null {
  if (!ctx.limits.canContinue('attachment_followthrough')) return null
  if (!shouldForceAttachmentFollowthrough({
    userMessage: ctx.message,
    enabledExtensions: ctx.sessionExtensions,
    hasToolCalls: ctx.state.hasToolCalls,
    hasAttachmentContext: ctx.hasAttachmentContext,
    classification: ctx.classification,
  })) return null
  const count = ctx.limits.increment('attachment_followthrough')
  const { max } = ctx.limits.getStatus('attachment_followthrough')
  writeStatus(ctx, {
    attachmentFollowthrough: count,
    maxFollowthroughs: max,
  })
  return { type: 'attachment_followthrough', requiredToolReminderNames: [] }
}

function checkDeliverableFollowthrough(ctx: ContinuationContext): ContinuationDecision | null {
  if (!ctx.limits.canContinue('deliverable_followthrough')) return null
  if (!shouldForceDeliverableFollowthrough({
    userMessage: ctx.message,
    finalResponse: resolveCurrentFinalResponse(ctx.state),
    hasToolCalls: ctx.state.hasToolCalls,
    toolEvents: ctx.state.streamedToolEvents,
    cwd: ctx.session.cwd,
    history: ctx.history,
    classification: ctx.classification,
  })) return null
  const count = ctx.limits.increment('deliverable_followthrough')
  const { max } = ctx.limits.getStatus('deliverable_followthrough')
  writeStatus(ctx, {
    deliverableFollowthrough: count,
    maxFollowthroughs: max,
  })
  return { type: 'deliverable_followthrough', requiredToolReminderNames: [] }
}

function checkIncompleteDelegation(ctx: ContinuationContext): ContinuationDecision | null {
  if (!ctx.limits.canContinue('unfinished_tool_followthrough')) return null
  if (!hasIncompleteDelegationWait(ctx.state.streamedToolEvents)) return null
  ctx.limits.increment('unfinished_tool_followthrough')
  writeStatus(ctx, { unfinishedDelegation: true })
  return { type: 'unfinished_tool_followthrough', requiredToolReminderNames: [] }
}

function checkToolErrorFollowthrough(ctx: ContinuationContext): ContinuationDecision | null {
  if (!ctx.limits.canContinue('tool_error_followthrough')) return null
  if (!shouldForceRecoverableToolErrorFollowthrough({
    userMessage: ctx.message,
    finalResponse: resolveCurrentFinalResponse(ctx.state),
    hasToolCalls: ctx.state.hasToolCalls,
    toolEvents: ctx.state.streamedToolEvents,
  })) return null
  const count = ctx.limits.increment('tool_error_followthrough')
  const { max } = ctx.limits.getStatus('tool_error_followthrough')
  writeStatus(ctx, {
    toolErrorRecovery: count,
    maxFollowthroughs: max,
  })
  return { type: 'tool_error_followthrough', requiredToolReminderNames: [] }
}

function checkCoordinatorDelegation(ctx: ContinuationContext): ContinuationDecision | null {
  if (!ctx.delegationEnabled || !ctx.delegationPreferenceActive) return null
  if (!ctx.limits.canContinue('coordinator_delegation_nudge')) return null
  // Skip if already delegated
  const delegationTools = ['spawn_subagent', 'manage_protocols']
  if (delegationTools.some(t => ctx.state.usedToolNames.has(t))) return null
  // Only nudge if coordinator made 2+ direct substantial tool calls
  const directTools = ['files', 'edit_file', 'shell', 'web']
  const directCallCount = directTools.filter(t => ctx.state.usedToolNames.has(t)).length
  if (directCallCount < 2) return null
  ctx.limits.increment('coordinator_delegation_nudge')
  writeStatus(ctx, { coordinatorDelegationNudge: true })
  return { type: 'coordinator_delegation_nudge', requiredToolReminderNames: [] }
}

function checkToolSummary(ctx: ContinuationContext): ContinuationDecision | null {
  if (!ctx.state.hasToolCalls) return null
  if (ctx.state.streamedToolEvents.length === 0) return null
  if (!ctx.limits.canContinue('tool_summary')) return null
  const skipToolSummaryForShortResponse = shouldSkipToolSummaryForShortResponse({
    fullText: ctx.state.fullText,
    toolEvents: ctx.state.streamedToolEvents,
    isConnectorSession: ctx.isConnectorSession,
  })
  if (skipToolSummaryForShortResponse) return null
  const textIsTrivial = !ctx.state.fullText.trim() || (
    !ctx.isConnectorSession && ctx.state.fullText.trim().length < 150
    && (
      ctx.state.streamedToolEvents.length >= 2
      || ctx.likelyResearchSynthesisTask
      || classifiedIsDeliverableTask(ctx.classification, ctx.message)
    )
  )
  if (!textIsTrivial) return null
  const currentLen = ctx.state.fullText.length
  const priorLen = ctx.state.lastToolSummaryTextLen
  if (!toolSummaryHasMeaningfulProgress(priorLen, currentLen)) {
    logStatus(ctx, 'decision', `Tool summary retry skipped — no meaningful progress (delta=${currentLen - priorLen} chars)`, {
      priorLen, currentLen, toolEventCount: ctx.state.streamedToolEvents.length,
    })
    return null
  }
  ctx.state.lastToolSummaryTextLen = currentLen
  const count = ctx.limits.increment('tool_summary')
  const summaryReason = !ctx.state.fullText.trim() ? 'empty_response_after_tools' : 'trivial_preamble_after_tools'
  logStatus(ctx, 'decision', `Tools called but response text is trivial (${ctx.state.fullText.trim().length} chars) — forcing summary continuation`, {
    toolEventCount: ctx.state.streamedToolEvents.length, toolSummaryRetryCount: count, textLength: ctx.state.fullText.trim().length,
  })
  writeStatus(ctx, { toolSummary: count, reason: summaryReason })
  return { type: 'tool_summary', requiredToolReminderNames: [] }
}

function logStatus(ctx: ContinuationContext, kind: LogCategory, msg: string, detail: Record<string, unknown>): void {
  // Use the session from context — lightweight inline logging
  const session = ctx.session as unknown as { id: string; agentId?: string }
  if ('id' in session) {
    logExecution(session.id, kind, msg, { agentId: session.agentId, detail })
  }
}

// ---------------------------------------------------------------------------
// Public evaluator
// ---------------------------------------------------------------------------

/**
 * Walk the continuation checks in priority order, returning the first match.
 * Returns `{ type: false }` when no continuation is warranted.
 *
 * 9 checks (consolidated from 13):
 *  1. checkUnfinishedToolCallsPending
 *  2. checkLoopDetection
 *  3. checkExecutionContinuation (merged: reason + kickoff + external)
 *  4. checkRequiredTools (merged: explicit + shell fallback)
 *  5. checkMemoryWriteFollowthrough
 *  6. checkAttachmentFollowthrough
 *  7. checkDeliverableFollowthrough
 *  8. checkIncompleteDelegation
 *  9. checkToolErrorFollowthrough
 * 10. checkToolSummary
 */
export function evaluateContinuation(ctx: ContinuationContext): ContinuationDecision {
  const checks = [
    checkUnfinishedToolCallsPending,
    checkLoopDetection,
    checkLightweightDirectChat,
    checkCoordinatorDelegation,
    checkExecutionContinuation,
    checkRequiredTools,
    checkMemoryWriteFollowthrough,
    checkAttachmentFollowthrough,
    checkDeliverableFollowthrough,
    checkIncompleteDelegation,
    checkToolErrorFollowthrough,
    checkToolSummary,
  ]

  for (const check of checks) {
    const decision = check(ctx)
    if (decision) return decision
  }

  return { type: false, requiredToolReminderNames: [] }
}
