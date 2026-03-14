/**
 * Continuation logic for stream-agent-chat.
 *
 * Determines whether an LLM iteration should continue (and why),
 * builds the appropriate follow-up prompts, and resolves final
 * response text from tool-heavy turns.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MessageToolEvent } from '@/types'
import { extractSuggestions } from '@/lib/server/suggestions'
import { isSuccessfulMemoryMutationToolEvent } from '@/lib/server/chat-execution/memory-mutation-tools'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContinuationType =
  | 'memory_write_followthrough'
  | 'recursion'
  | 'transient'
  | 'required_tool'
  | 'attachment_followthrough'
  | 'execution_kickoff_followthrough'
  | 'execution_followthrough'
  | 'deliverable_followthrough'
  | 'unfinished_tool_followthrough'
  | 'tool_error_followthrough'
  | 'tool_summary'
  | false

function looksLikeToolErrorOutput(output: string): boolean {
  const trimmed = String(output || '').trim()
  if (!trimmed) return false
  if (/^(Error(?::|\s*\(exit\b[^)]*\):?)|error:)/i.test(trimmed)) return true
  if (/\b(MCP error|ECONNREFUSED|ETIMEDOUT|ERR_CONNECTION_REFUSED|ENOENT|EACCES|AbortError)\b/i.test(trimmed)) return true
  if (/\b(timeout|timed?\s*out|aborted|target closed|execution context was destroyed|temporarily unavailable)\b/i.test(trimmed)) return true
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const status = typeof parsed.status === 'string' ? parsed.status.trim().toLowerCase() : ''
    if (status === 'error' || status === 'failed') return true
    if (typeof parsed.error === 'string' && parsed.error.trim()) return true
  } catch {
    // Ignore non-JSON tool output.
  }
  return false
}

// ---------------------------------------------------------------------------
// Message classification helpers
// ---------------------------------------------------------------------------

export function isBroadGoal(text: string): boolean {
  if (text.length < 50) return false
  if (/```/.test(text)) return false
  if (/\/(src|lib|app|pages|components|api)\//.test(text)) return false
  if (/^\s*\d+[.)]\s/m.test(text)) return false
  if (text.length < 80 && text.endsWith('?')) return false
  return true
}

export function looksLikeExternalWalletTask(text: string): boolean {
  const normalized = text.toLowerCase()
  if (!normalized.trim()) return false
  return /\b(wallet|wallet connect|walletconnect|trade|trading|exchange|dex|bridge|swap|deposit|withdraw|onchain|token|gas|hyperliquid|arbitrum|ethereum|solana|base|usdc|eth|sol)\b/.test(normalized)
}

export function looksLikeBoundedExternalExecutionTask(text: string): boolean {
  const normalized = text.toLowerCase()
  if (!looksLikeExternalWalletTask(text)) return false
  return /\b(live|swap|trade|buy|purchase|sell|mint|claim|execute|transact|transaction|approve|broadcast)\b/.test(normalized)
}

export function looksLikeOpenEndedDeliverableTask(text: string): boolean {
  const normalized = text.toLowerCase()
  if (!normalized.trim()) return false
  if (/```|package\.json|tsconfig|\btsx?\b|\bjsx?\b|pytest|vitest|npm run|src\/|components\/|api\//.test(normalized)) return false
  if (/\b(revise|revision|iterate|iteration|draft|deliverable|deliverables|offer|brief|copy|proposal|landing|outreach|plan|strategy|report|memo|document|docs?)\b/.test(normalized)) return true
  if (
    /\b(create|build|generate|make|write|produce)\b/.test(normalized)
    && /\b(save|write|output|export)\b[^.!?\n]{0,60}\b(to|as|in)\b[^.!?\n]{0,40}(\/|~\/|\.\/|\.[a-z]{2,5}\b)/.test(normalized)
  ) {
    return true
  }
  if (
    isBroadGoal(text)
    && /\b(create|build|generate|make|write|research|capture|take|start|produce)\b/.test(normalized)
    && /\b(screenshot|screenshots|image|images|markdown|\.md\b|md\b|md files?|pdf|pdf files?|html|html\s+(?:page|file)|dashboard|site|sites|website|web page|webpage|dev server|dev servers|artifact|artifacts|topic|topics)\b/.test(normalized)
  ) {
    return true
  }
  return isBroadGoal(text) && /(\.md\b|\.txt\b|\.html\b|\.json\b|copy|brief|proposal|plan|report|draft|document|dashboard)/.test(normalized)
}

function looksLikeIncompleteDeliverableResponse(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (trimmed.endsWith(':') || trimmed.endsWith('...') || trimmed.endsWith('…')) return true
  const lastChunk = trimmed.slice(-400).toLowerCase()
  return /\b(?:next|now|then|after that|moving on to|proceeding to)\b[^.!?\n]{0,120}\b(?:i(?:'ll| will)|create|build|write|capture|take|start|finish|generate)\b/.test(lastChunk)
    || /\b(?:i(?:'ll| will)|let me)\s+(?:now|next)?\s*(?:create|build|write|capture|take|start|finish|generate|continue)\b/.test(lastChunk)
}

const ARTIFACT_PATH_EXT_RE = /\.(?:md|txt|html?|json|csv|ya?ml|xml|pdf|png|jpe?g|webp|gif|svg|zip|ts|tsx|js|jsx|mjs|cjs|py|sql|sh)$/i
const EXPLICIT_ARTIFACT_OUTPUT_RE = /\b(?:save|write|output|export|create|generate)\b[^.!?\n]{0,80}\b(?:to|as|at|in)\b[^.!?\n]{0,60}(\/[^\s,'"]+\.(?:md|txt|html?|json|csv|ya?ml|xml|pdf|png|jpe?g|webp|gif|svg|zip|py|ts|tsx|js|jsx|mjs|cjs|sql|sh)|~\/[^\s,'"]+\.(?:md|txt|html?|json|csv|ya?ml|xml|pdf|png|jpe?g|webp|gif|svg|zip|py|ts|tsx|js|jsx|mjs|cjs|sql|sh)|\.\/[^\s,'"]+\.(?:md|txt|html?|json|csv|ya?ml|xml|pdf|png|jpe?g|webp|gif|svg|zip|py|ts|tsx|js|jsx|mjs|cjs|sql|sh)|[a-z0-9._/-]+\.(?:md|txt|html?|json|csv|ya?ml|xml|pdf|png|jpe?g|webp|gif|svg|zip|py|ts|tsx|js|jsx|mjs|cjs|sql|sh)\b)/i

function hasExplicitFileOutputRequest(text: string): boolean {
  const normalized = text.toLowerCase()
  return EXPLICIT_ARTIFACT_OUTPUT_RE.test(normalized)
}

function normalizeArtifactPathCandidate(raw: string): string {
  return raw
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .replace(/[),.;:]+$/g, '')
}

function isLikelyArtifactPath(value: string): boolean {
  const normalized = normalizeArtifactPathCandidate(value)
  if (!normalized) return false
  if (/^(?:https?:\/\/|file:\/\/|sandbox:\/api\/uploads\/|\/api\/uploads\/)/i.test(normalized)) return false
  if (!ARTIFACT_PATH_EXT_RE.test(normalized)) return false
  return normalized.includes('/') || normalized.startsWith('~') || normalized.startsWith('.') || ARTIFACT_PATH_EXT_RE.test(path.basename(normalized))
}

function collectArtifactPathCandidates(text: string): string[] {
  const candidates = new Set<string>()

  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const candidate = normalizeArtifactPathCandidate(match[1] || '')
    if (isLikelyArtifactPath(candidate)) candidates.add(candidate)
  }

  for (const match of text.matchAll(/["']([^"'\n]+)["']/g)) {
    const candidate = normalizeArtifactPathCandidate(match[1] || '')
    if (isLikelyArtifactPath(candidate)) candidates.add(candidate)
  }

  for (const match of text.matchAll(/(?:^|[\s(])((?:\/|~\/|\.\.?\/)[^\s,'"`)]+|[A-Za-z0-9._-]+\/[A-Za-z0-9._/\-]+\.[A-Za-z0-9]{1,8}|[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8})(?=$|[\s),.;:])/g)) {
    const candidate = normalizeArtifactPathCandidate(match[1] || '')
    if (isLikelyArtifactPath(candidate)) candidates.add(candidate)
  }

  return [...candidates]
}

function resolveArtifactPath(cwd: string, candidate: string): string {
  if (candidate.startsWith('~/')) return path.join(os.homedir(), candidate.slice(2))
  if (path.isAbsolute(candidate)) return candidate
  return path.resolve(cwd, candidate)
}

function artifactLooksMaterialized(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath)
    if (!stats.isFile() || stats.size <= 0) return false
    if (/\.(?:png|jpe?g|webp|gif|pdf|zip)$/i.test(filePath)) return true
    return fs.readFileSync(filePath, 'utf8').trim().length > 0
  } catch {
    return false
  }
}

function getRequestedArtifactStatus(params: {
  userMessage: string
  cwd?: string
}): { requested: string[]; missing: string[] } {
  if (!params.cwd) return { requested: [], missing: [] }
  const requested = collectArtifactPathCandidates(params.userMessage)
  const missing = requested.filter((candidate) => !artifactLooksMaterialized(resolveArtifactPath(params.cwd!, candidate)))
  return { requested, missing }
}

// ---------------------------------------------------------------------------
// Tool evidence analysis
// ---------------------------------------------------------------------------

export function hasStateChangingWalletEvidence(toolEvents: MessageToolEvent[]): boolean {
  return toolEvents.some((event) => {
    const input = `${event.input || ''}\n${event.output || ''}`
    return event.name === 'wallet_tool' && (
      /"action":"send_transaction"/.test(input)
      || /"action":"send"/.test(input)
      || /"action":"sign_transaction"/.test(input)
      || /"type":"plugin_wallet_action_request"/.test(input)
      || /"type":"plugin_wallet_transfer_request"/.test(input)
      || /"status":"broadcast"/.test(input)
    )
  })
}

export function countExternalExecutionResearchSteps(toolEvents: MessageToolEvent[]): number {
  return toolEvents.filter((event) => {
    if (['http_request', 'web', 'web_search', 'web_fetch', 'browser'].includes(event.name)) return true
    if (event.name !== 'wallet_tool') return false
    return /"action":"(balance|address|transactions|call_contract|encode_contract_call)"/.test(event.input || '')
  }).length
}

export function countDistinctExternalResearchHosts(toolEvents: MessageToolEvent[]): number {
  const hosts = new Set<string>()
  for (const event of toolEvents) {
    const candidates = [event.input || '', event.output || '']
    for (const candidate of candidates) {
      const matches = candidate.match(/https?:\/\/[^"'\\\s)]+/g) || []
      for (const match of matches) {
        try {
          hosts.add(new URL(match).host.toLowerCase())
        } catch {
          // Ignore malformed URLs in model/tool text.
        }
      }
    }
  }
  return hosts.size
}

// ---------------------------------------------------------------------------
// Continuation decision helpers
// ---------------------------------------------------------------------------

export function shouldForceExternalExecutionFollowthrough(params: {
  userMessage: string
  finalResponse: string
  hasToolCalls: boolean
  toolEvents: MessageToolEvent[]
}): boolean {
  if (!looksLikeBoundedExternalExecutionTask(params.userMessage)) return false
  if (!params.hasToolCalls || params.toolEvents.length < 4) return false
  if (hasStateChangingWalletEvidence(params.toolEvents)) return false
  const distinctHosts = countDistinctExternalResearchHosts(params.toolEvents)
  const trimmed = params.finalResponse.trim()
  if (!trimmed) return countExternalExecutionResearchSteps(params.toolEvents) >= 4 || distinctHosts >= 3
  if (/\b(last reversible step|exact blocker|safest next action|blocked|cannot|can't|missing capability|no-key route unavailable)\b/i.test(trimmed)) {
    return false
  }
  if (countExternalExecutionResearchSteps(params.toolEvents) < 4 && distinctHosts < 3) return false
  return /(let me|i'll|i will|trying|research|query|check|look|promising|now let me|good -|good,)/i.test(trimmed) || trimmed.length < 500
}

export function shouldForceExternalExecutionKickoffFollowthrough(params: {
  userMessage: string
  finalResponse: string
  hasToolCalls: boolean
  toolEvents: MessageToolEvent[]
}): boolean {
  if (!looksLikeBoundedExternalExecutionTask(params.userMessage)) return false
  if (params.hasToolCalls || params.toolEvents.length > 0) return false

  const trimmed = params.finalResponse.trim()
  if (!trimmed) return true
  if (/^(?:HEARTBEAT_OK|NO_MESSAGE)\b/i.test(trimmed)) return false
  if (/\?\s*$/.test(trimmed)) return false
  if (/\b(last reversible step|exact blocker|blocked|cannot|can't|missing capability|need approval|requires approval|approval boundary|requires human|ask_human|credential|authentication|login|2fa|mfa|captcha)\b/i.test(trimmed)) {
    return false
  }
  if (/\b(done|completed|finished|sent|broadcast|minted|purchased|bought|swapped|claimed)\b/i.test(trimmed)) {
    return false
  }
  return looksLikeIncompleteDeliverableResponse(trimmed) || trimmed.length < 220
}

export function shouldForceDeliverableFollowthrough(params: {
  userMessage: string
  finalResponse: string
  hasToolCalls: boolean
  toolEvents: MessageToolEvent[]
  cwd?: string
}): boolean {
  if (!looksLikeOpenEndedDeliverableTask(params.userMessage)) return false
  const requestedArtifacts = getRequestedArtifactStatus({
    userMessage: params.userMessage,
    cwd: params.cwd,
  })
  const explicitFileOutputRequest = hasExplicitFileOutputRequest(params.userMessage)
  const usedFileWriteTools = params.toolEvents.some((e) => {
    if (!e.name) return false
    if (['write_file', 'edit_file'].includes(e.name)) return true
    if (e.name === 'shell' || e.name === 'execute_command') return true
    if (e.name === 'files') {
      const input = e.input || ''
      return /"action"\s*:\s*"write"/i.test(input)
    }
    return false
  })
  if (requestedArtifacts.missing.length > 0) return true
  const trimmed = params.finalResponse.trim()
  if (!params.hasToolCalls || params.toolEvents.length === 0) {
    if (!trimmed) return explicitFileOutputRequest
    if (explicitFileOutputRequest) return true
    return looksLikeIncompleteDeliverableResponse(trimmed)
  }
  if (!trimmed) return params.toolEvents.length >= 2
  if (
    /\b(task complete|completed|finished|done|delivered|shared|sent|uploaded|attached)\b/i.test(trimmed)
    && /(?:\/api\/uploads\/|https?:\/\/|`[^`\n]+\.(?:md|pdf|png|jpe?g|webp|gif|html|txt|zip)`)/i.test(trimmed)
  ) {
    return false
  }
  if (explicitFileOutputRequest && !usedFileWriteTools) return true
  if (looksLikeIncompleteDeliverableResponse(trimmed)) return true
  return trimmed.length < 120 && params.toolEvents.length >= 3
}

const RECOVERABLE_TOOL_ERROR_NAMES = new Set([
  'browser',
  'openclaw_browser',
  'web',
  'web_search',
  'web_fetch',
  'http_request',
])

export function shouldForceRecoverableToolErrorFollowthrough(params: {
  userMessage: string
  finalResponse: string
  hasToolCalls: boolean
  toolEvents: MessageToolEvent[]
}): boolean {
  if (!params.hasToolCalls || params.toolEvents.length === 0) return false
  const completedEvents = params.toolEvents.filter((event) => typeof event.output === 'string' && event.output.trim().length > 0)
  const lastCompleted = completedEvents.at(-1)
  if (!lastCompleted) return false
  if (!RECOVERABLE_TOOL_ERROR_NAMES.has(lastCompleted.name)) return false

  const lastOutput = extractSuggestions(lastCompleted.output || '').clean.trim()
  if (!looksLikeToolErrorOutput(lastOutput)) return false

  const trimmed = params.finalResponse.trim()
  if (!trimmed) return true
  if (/\b(captcha|2fa|mfa|verification code|requires human|ask_human|human input|missing credential|authentication required|permission denied|approval boundary)\b/i.test(trimmed)) {
    return false
  }
  if (/\b(timeout|timed?\s*out|aborted|failed|error|could not|couldn't|did not load|didn't load|operation was aborted)\b/i.test(trimmed)) {
    return true
  }
  return trimmed.length < 220
}

// ---------------------------------------------------------------------------
// Tool evidence rendering (shared with buildForcedExternalServiceSummary)
// ---------------------------------------------------------------------------

export function renderToolEvidence(events: MessageToolEvent[]): string {
  return events
    .slice(-10)
    .map((event, index) => [
      `Tool ${index + 1}: ${event.name}`,
      event.input ? `Input: ${event.input}` : '',
      event.output ? `Output: ${event.output.slice(0, 1200)}` : '',
    ].filter(Boolean).join('\n'))
    .join('\n\n')
}

// ---------------------------------------------------------------------------
// Continuation prompt builders
// ---------------------------------------------------------------------------

function buildExternalExecutionFollowthroughPrompt(params: {
  userMessage: string
  fullText: string
  toolEvents: MessageToolEvent[]
}): string {
  return [
    'You are in a bounded external execution task and have already done enough research.',
    'Do not restart broad discovery. Do not ask the user for another prompt.',
    'Do not spend this continuation on more venue shopping. Use the already confirmed route unless one last fetch is strictly required to prepare execution.',
    'If several venue or aggregator APIs already failed, stop searching for more venues. Either use a direct onchain read path with the available wallet tools, or state the blocker.',
    'A prose approval request does not count as completion. If the next step is a sign/send/approve action, call the real wallet tool action so the runtime can create the approval request.',
    'Do not mutate already confirmed token addresses, router addresses, spender addresses, or network identifiers unless newer tool evidence proves the earlier value was wrong.',
    'Within this continuation, do exactly one of the following:',
    '1. Take the next concrete execution step now using the existing tools and stop at the first approval boundary for a state-changing action.',
    '2. If no safe executable step exists with the current tools, state the exact blocker with evidence.',
    'A successful continuation ends with one of these outcomes only: an approval request, a broadcast transaction, or a final blocker summary.',
    'Prefer the route sources and facts already confirmed in the tool evidence below. Do not keep shopping for new venues unless the current options are clearly unusable.',
    'If the tool evidence already includes enough information to prepare a contract call, approval, quote read, or transaction simulation, do that now instead of making another search or HTTP request.',
    '',
    `Objective:\n${params.userMessage}`,
    '',
    `Current partial response:\n${params.fullText || '(none)'}`,
    '',
    `Recent tool evidence:\n${renderToolEvidence(params.toolEvents) || '(none)'}`,
  ].join('\n')
}

function buildExternalExecutionKickoffPrompt(params: {
  userMessage: string
  fullText: string
}): string {
  return [
    'The previous iteration stopped after an intent update before taking the first concrete execution step.',
    'Do not send another preamble like "let me check", "I will try", or "I\'m going to".',
    'Continue immediately from the same objective and take the first concrete reversible step now using the available tools.',
    'If a real blocker appears before any safe action, state the exact blocker with evidence instead of narrating your plan.',
    'Do not ask the user to repeat the task. Either act now or report the blocker.',
    '',
    `Objective:\n${params.userMessage}`,
    '',
    `Previous response:\n${params.fullText || '(none)'}`,
  ].join('\n')
}

function buildDeliverableFollowthroughPrompt(params: {
  userMessage: string
  fullText: string
  toolEvents: MessageToolEvent[]
  cwd?: string
}): string {
  const lines = [
    'You are in the middle of a multi-step deliverable and stopped after only a partial batch of work.',
    'Continue from the existing workspace and artifacts. Do not restart from scratch and do not ask the user to restate the request.',
    'Do not stop after one partial batch. Finish every requested deliverable that is still outstanding before concluding.',
    'If a requested artifact cannot be produced, say exactly which artifact is missing, what blocked it, and what you already completed.',
    'Use the existing files, screenshots, and generated outputs first. Inspect them if needed, then complete the remaining work.',
    'Preserve hard structural constraints from the original request: exact counts stay exact, required titled sections stay present, and source coverage gaps should be filled instead of skipped.',
    'End with a concise grouped completion summary that lists exact file paths, upload URLs, localhost URLs/ports, and screenshots you produced.',
  ]
  const requestedArtifacts = getRequestedArtifactStatus({
    userMessage: params.userMessage,
    cwd: params.cwd,
  })
  if (requestedArtifacts.missing.length > 0) {
    lines.push(
      '',
      'CRITICAL: The following requested artifacts are still missing from the workspace:',
      ...requestedArtifacts.missing.map((candidate) => `- ${candidate}`),
      'Write or repair every missing artifact before you conclude.',
    )
  }

  const userNormalized = params.userMessage.toLowerCase()
  const fileOutputMatch = userNormalized.match(/\b(?:save|write|output|export)\b[^.!?\n]{0,80}\b(?:to|as|at|in)\b[^.!?\n]{0,60}(\/[^\s,'"]+|~\/[^\s,'"]+|\.\/[^\s,'"]+)/i)
  if (fileOutputMatch) {
    const fileToolNames = ['write_file', 'edit_file', 'files', 'shell', 'execute_command']
    const usedFileTools = params.toolEvents.some((e) => e.name && fileToolNames.includes(e.name))
    if (!usedFileTools) {
      lines.push(
        '',
        `CRITICAL: The user asked you to save output to a file path (${fileOutputMatch[1] || 'see objective'}). You have NOT used any file-writing tool yet.`,
        'You MUST use the `files` or `write_file` tool to write the content to the requested path. Do not just include the content in your text response — actually write the file.',
      )
    }
  }

  if (
    params.toolEvents.some((event) => ['web', 'web_search', 'web_fetch', 'browser', 'http_request'].includes(event.name))
    && !params.toolEvents.some((event) => ['files', 'write_file', 'edit_file', 'shell', 'execute_command'].includes(event.name))
  ) {
    lines.push(
      '',
      'You already have enough research evidence to draft the requested deliverable.',
      'Stop gathering more sources unless a specific required section is still unsupported. Write the artifact now and then give the completion summary.',
    )
  }

  lines.push(
    '',
    `Objective:\n${params.userMessage}`,
    '',
    `Current partial response:\n${params.fullText || '(none)'}`,
    '',
    `Recent tool evidence:\n${renderToolEvidence(params.toolEvents) || '(none)'}`,
  )
  return lines.join('\n')
}

function buildAttachmentFollowthroughPrompt(params: {
  message: string
  fullText: string
}): string {
  return [
    'The current thread already includes user attachments as inline context.',
    'Image attachments are directly visible to you in the message content. Text and PDF attachments are also available inline when present.',
    'Do not claim that you cannot use images, attachments, or external tools when they are available in this session.',
    'If the user wants you to look something up from an attachment, first extract the identifier or details from the attachment/history, then use the enabled tools to continue.',
    'Only state a blocker if the attachment is genuinely unreadable or a needed tool is actually unavailable after a real attempt.',
    '',
    `Original request:\n${params.message}`,
    '',
    `Your previous response:\n${params.fullText || '(none)'}`,
    '',
    'Now continue and handle the attachment-aware task correctly.',
  ].join('\n')
}

function buildToolSummaryPrompt(params: {
  message: string
  fullText: string
  toolEvents: MessageToolEvent[]
}): string {
  const toolSummaryLines = params.toolEvents
    .filter((e) => e.output)
    .map((e) => `[${e.name}]: ${(e.output || '').slice(0, 500)}`)
    .slice(0, 6)
  const preambleNote = params.fullText.trim()
    ? `You started with "${params.fullText.trim().slice(0, 100)}..." but did not follow through with actual results.`
    : 'Your tool calls completed but you did not provide a response.'
  return [
    preambleNote,
    'Here are the tool results:',
    ...toolSummaryLines,
    '',
    `Original request: ${params.message.slice(0, 500)}`,
    '',
    'Now answer the original request using these tool results. Be concise and direct. Present the findings clearly.',
  ].join('\n')
}

function buildToolErrorFollowthroughPrompt(params: {
  message: string
  fullText: string
  toolEvents: MessageToolEvent[]
}): string {
  return [
    'A recent browser or web tool attempt failed, but that is not a terminal outcome by itself.',
    'Do not stop after the first failed acquisition attempt.',
    'Retry with a corrected target, a simpler page step, or one other enabled acquisition path if that is safer.',
    'For browser timeouts or aborted loads, prefer one concrete retry or an alternate page/site instead of ending on the raw tool error.',
    'Only conclude with a blocker if you have already tried a reasonable alternative path or the page now clearly requires human input, credentials, approval, or another unavailable capability.',
    '',
    `Objective:\n${params.message}`,
    '',
    `Current partial response:\n${params.fullText || '(none)'}`,
    '',
    `Recent tool evidence:\n${renderToolEvidence(params.toolEvents) || '(none)'}`,
  ].join('\n')
}

function buildUnfinishedToolFollowthroughPrompt(params: {
  message: string
  fullText: string
  toolEvents: MessageToolEvent[]
}): string {
  const completed = params.toolEvents
    .filter((event) => typeof event.output === 'string' && event.output.length > 0)
    .map((event) => `[${event.name}]: ${String(event.output || '').slice(0, 400)}`)
    .slice(0, 6)
  const pending = params.toolEvents
    .filter((event) => !event.output)
    .map((event) => `[${event.name}] ${String(event.input || '').slice(0, 240)}`)
    .slice(0, 6)

  return [
    'The previous iteration ended before all tool calls finished returning results.',
    'Do not finalize with an interim sentence or restart the whole workflow from scratch.',
    'Continue from the current tool evidence. If a still-needed tool result is missing, rerun only that missing step and then finish the task.',
    'If the task asked for a saved artifact, actually create it before you conclude.',
    '',
    `Objective:\n${params.message}`,
    '',
    `Current partial response:\n${params.fullText || '(none)'}`,
    '',
    'Completed tool evidence:',
    ...(completed.length > 0 ? completed : ['(none)']),
    '',
    'Tool calls that ended without a surfaced result:',
    ...(pending.length > 0 ? pending : ['(none)']),
  ].join('\n')
}

function buildRequiredToolPrompt(params: {
  message: string
  fullText: string
  toolEvents: MessageToolEvent[]
  requiredToolReminderNames: string[]
}): string {
  const needsSavedArtifact = hasExplicitFileOutputRequest(params.message)
  const fileReminder = params.requiredToolReminderNames.some((toolName) => ['files', 'write_file', 'edit_file', 'shell'].includes(toolName))
  if (needsSavedArtifact && fileReminder) {
    return [
      `You have not yet completed the required explicit tool step(s): ${params.requiredToolReminderNames.join(', ')}.`,
      'The user asked for a saved workspace artifact. Success requires an actual file write, not just prose in the chat.',
      'Use a file-writing tool now to create the requested artifact path before declaring success.',
      'Do not spend this continuation on more research unless one specific required section is still unsupported by the evidence you already gathered.',
      '',
      `Objective:\n${params.message}`,
      '',
      `Current partial response:\n${params.fullText || '(none)'}`,
      '',
      `Recent tool evidence:\n${renderToolEvidence(params.toolEvents) || '(none)'}`,
    ].join('\n')
  }

  return `You have not yet completed the required explicit tool step(s): ${params.requiredToolReminderNames.join(', ')}. Use those enabled tools now before declaring success. Do not replace ask_human with a plain-text request, do not replace outbound delivery tools with prose, and do not replace screenshot requests with text-only summaries.`
}

function buildMemoryWriteFollowthroughPrompt(): string {
  return [
    'The memory write already succeeded.',
    'Do not repeat the raw tool output, memory ID, category, or any "stored memory" wording.',
    'Do not call another memory, web, or history tool unless the user explicitly asked you to verify.',
    'Do not answer with NO_MESSAGE or HEARTBEAT_OK.',
    'Reply naturally in one short sentence that acknowledges what changed.',
    'If the stored memory was a name, nickname, or reply-medium preference, immediately use that preference in the acknowledgement itself.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// buildContinuationPrompt — unified prompt builder for all continuation types
// ---------------------------------------------------------------------------

/**
 * Returns the human-message prompt for a given continuation type,
 * or `null` for types that don't push a message (e.g. `transient`).
 */
export function buildContinuationPrompt(params: {
  type: ContinuationType
  message: string
  fullText: string
  toolEvents: MessageToolEvent[]
  requiredToolReminderNames: string[]
  cwd?: string
}): string | null {
  switch (params.type) {
    case 'memory_write_followthrough':
      return buildMemoryWriteFollowthroughPrompt()

    case 'recursion':
      return 'Continue where you left off. Complete the remaining steps of the objective.'

    case 'required_tool':
      return buildRequiredToolPrompt({
        message: params.message,
        fullText: params.fullText,
        toolEvents: params.toolEvents,
        requiredToolReminderNames: params.requiredToolReminderNames,
      })

    case 'attachment_followthrough':
      return buildAttachmentFollowthroughPrompt({
        message: params.message,
        fullText: params.fullText,
      })

    case 'execution_kickoff_followthrough':
      return buildExternalExecutionKickoffPrompt({
        userMessage: params.message,
        fullText: params.fullText,
      })

    case 'execution_followthrough':
      return buildExternalExecutionFollowthroughPrompt({
        userMessage: params.message,
        fullText: params.fullText,
        toolEvents: params.toolEvents,
      })

    case 'deliverable_followthrough':
      return buildDeliverableFollowthroughPrompt({
        userMessage: params.message,
        fullText: params.fullText,
        toolEvents: params.toolEvents,
        cwd: params.cwd,
      })

    case 'unfinished_tool_followthrough':
      return buildUnfinishedToolFollowthroughPrompt({
        message: params.message,
        fullText: params.fullText,
        toolEvents: params.toolEvents,
      })

    case 'tool_error_followthrough':
      return buildToolErrorFollowthroughPrompt({
        message: params.message,
        fullText: params.fullText,
        toolEvents: params.toolEvents,
      })

    case 'tool_summary':
      return buildToolSummaryPrompt({
        message: params.message,
        fullText: params.fullText,
        toolEvents: params.toolEvents,
      })

    case 'transient':
    case false:
      return null
  }
}

// ---------------------------------------------------------------------------
// Response text resolution
// ---------------------------------------------------------------------------

function resolveToolOnlyFinalResponse(toolEvents: MessageToolEvent[] | undefined): string {
  const events = Array.isArray(toolEvents) ? toolEvents : []
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (isSuccessfulMemoryMutationToolEvent(event)) continue
    const output = typeof event?.output === 'string'
      ? extractSuggestions(event.output).clean.trim()
      : ''
    if (!output) continue
    if (/^error[:\s]/i.test(output)) continue
    const delegationFallback = buildDelegationFallbackText(event)
    if (delegationFallback) return delegationFallback
    if (output.startsWith('{') || output.startsWith('[')) continue
    return output
  }
  return ''
}

function parseToolJsonRecord(raw: string | undefined): Record<string, unknown> | null {
  const cleaned = typeof raw === 'string' ? extractSuggestions(raw).clean.trim() : ''
  if (!cleaned.startsWith('{')) return null
  try {
    const parsed = JSON.parse(cleaned) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function buildDelegationFallbackText(event: MessageToolEvent): string {
  if (event.name !== 'spawn_subagent') return ''
  const output = parseToolJsonRecord(event.output)
  if (!output) return ''
  const input = parseToolJsonRecord(event.input)
  const action = typeof output.action === 'string'
    ? output.action
    : typeof input?.action === 'string'
      ? input.action
      : 'start'

  if (typeof output.response === 'string' && output.response.trim()) {
    return output.response.trim()
  }

  if (action === 'start' && typeof output.agentName === 'string' && typeof output.status === 'string') {
    return `${output.agentName} ${output.status}.`
  }

  if ((action === 'swarm' || action === 'swarm_status') && typeof output.swarmId === 'string' && output.swarmId.trim()) {
    const memberCount = numberField(output.memberCount)
    const status = typeof output.status === 'string' ? output.status : 'running'
    return `Swarm ${output.swarmId} is ${status}${memberCount !== null ? ` with ${memberCount} members` : ''}.`
  }

  const total = numberField(output.totalSpawned) ?? numberField(output.total) ?? numberField(output.taskCount)
  const completed = numberField(output.totalCompleted) ?? numberField(output.completed) ?? 0
  const failed = (numberField(output.totalFailed) ?? numberField(output.failed) ?? 0)
    + (numberField(output.totalSpawnErrors) ?? 0)
  const cancelled = numberField(output.totalCancelled) ?? numberField(output.cancelled) ?? 0
  if (total !== null && (action === 'batch' || action === 'swarm' || action === 'aggregate' || action === 'wait_all')) {
    return `Delegation ${typeof output.status === 'string' ? output.status : 'completed'}: ${completed}/${total} completed, ${failed} failed, ${cancelled} cancelled.`
  }

  return ''
}

export function hasIncompleteDelegationWait(toolEvents: MessageToolEvent[] | undefined): boolean {
  const events = Array.isArray(toolEvents) ? toolEvents : []
  return events.some((event) => {
    if (event.name !== 'spawn_subagent') return false
    const output = parseToolJsonRecord(event.output)
    if (!output) return false
    const input = parseToolJsonRecord(event.input)
    const action = typeof output.action === 'string'
      ? output.action
      : typeof input?.action === 'string'
        ? input.action
        : 'start'
    if (!['batch', 'swarm', 'aggregate', 'wait_all'].includes(action)) return false
    const expectsCompletion = input?.background !== true && input?.waitForCompletion !== false
    if (!expectsCompletion) return false
    if (Array.isArray(output.pending) && output.pending.length > 0) return true
    const status = typeof output.status === 'string' ? output.status : ''
    if (status === 'running' || status === 'spawning' || status === 'partial') return true
    const total = numberField(output.totalSpawned) ?? numberField(output.total)
    if (total === null) return false
    const completed = numberField(output.totalCompleted) ?? numberField(output.completed) ?? 0
    const failed = (numberField(output.totalFailed) ?? numberField(output.failed) ?? 0)
      + (numberField(output.totalSpawnErrors) ?? 0)
    const cancelled = numberField(output.totalCancelled) ?? numberField(output.cancelled) ?? 0
    return completed + failed + cancelled < total
  })
}

export function resolveFinalStreamResponseText(params: {
  fullText: string
  lastSegment: string
  lastSettledSegment: string
  hasToolCalls: boolean
  toolEvents?: MessageToolEvent[]
}): string {
  const fullText = params.fullText || ''
  if (!params.hasToolCalls) return fullText

  const candidates = [
    extractSuggestions(params.lastSegment || '').clean.trim(),
    extractSuggestions(params.lastSettledSegment || '').clean.trim(),
    extractSuggestions(fullText).clean.trim(),
    resolveToolOnlyFinalResponse(params.toolEvents),
  ]

  return candidates.find((candidate) => candidate.length > 0) || ''
}

export function resolveContinuationAssistantText(params: {
  iterationText: string
  lastSegment: string
}): string {
  const candidates = [
    extractSuggestions(params.iterationText || '').clean.trim(),
    extractSuggestions(params.lastSegment || '').clean.trim(),
  ]
  return candidates.find((candidate) => candidate.length > 0) || ''
}
