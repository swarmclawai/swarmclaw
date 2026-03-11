import type { Message } from '@/types'
import { getMemoryDb } from '@/lib/server/memory/memory-db'

import { repairTranscriptConsistency } from './transcript-repair'

// --- LLM compaction constants ---

const BASE_CHUNK_RATIO = 0.4
const MIN_CHUNK_RATIO = 0.15
const COMPACTION_SAFETY_MARGIN = 1.2
const COMPACTION_OVERHEAD_TOKENS = 4096
const DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000
const MIN_COMPACTION_RESERVE_TOKENS = 1_024
const MAX_TOOL_FAILURES = 8
const MAX_FAILURE_CHARS = 240

const MERGE_SUMMARIES_INSTRUCTIONS =
  'Merge these partial summaries into a single cohesive summary. Preserve decisions,' +
  ' TODOs, open questions, constraints, active tasks and their current status,' +
  ' batch operation progress (e.g., "5/17 items completed"),' +
  ' the last thing the user requested, and any commitments or follow-ups promised.'

const IDENTIFIER_PRESERVATION_INSTRUCTIONS =
  'Preserve all opaque identifiers exactly as written (no shortening or reconstruction), ' +
  'including UUIDs, hashes, IDs, tokens, API keys, hostnames, IPs, ports, URLs, and file names.'

/** Callback that sends a prompt to an LLM and returns response text */
export type LLMSummarizer = (prompt: string) => Promise<string>

// --- Context window sizes (tokens) per provider/model ---

const PROVIDER_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-sonnet-4-5-20250514': 200_000,
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4.1': 1_047_576,
  'gpt-4.1-mini': 1_047_576,
  'gpt-4.1-nano': 1_047_576,
  'o3': 200_000,
  'o3-mini': 128_000,
  'o4-mini': 200_000,
  // Codex CLI
  'gpt-5.3-codex': 1_047_576,
  'gpt-5.2-codex': 1_047_576,
  'gpt-5.1-codex': 1_047_576,
  'gpt-5-codex': 1_047_576,
  'gpt-5-codex-mini': 1_047_576,
  // Google Gemini
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-flash-lite': 1_048_576,
  // DeepSeek
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,
  // Mistral
  'mistral-large-latest': 128_000,
  'mistral-small-latest': 128_000,
  'magistral-medium-2506': 128_000,
  'devstral-small-latest': 128_000,
  // xAI
  'grok-3': 131_072,
  'grok-3-fast': 131_072,
  'grok-3-mini': 131_072,
  'grok-3-mini-fast': 131_072,
}

const PROVIDER_DEFAULT_WINDOWS: Record<string, number> = {
  anthropic: 200_000,
  'claude-cli': 200_000,
  openai: 128_000,
  'codex-cli': 1_047_576,
  'opencode-cli': 200_000,
  google: 1_048_576,
  deepseek: 64_000,
  groq: 32_768,
  together: 32_768,
  mistral: 128_000,
  xai: 131_072,
  fireworks: 32_768,
  ollama: 32_768,
  openclaw: 128_000,
}

/** Get context window size for a model, falling back to provider default */
export function getContextWindowSize(provider: string, model: string): number {
  return PROVIDER_CONTEXT_WINDOWS[model]
    || PROVIDER_DEFAULT_WINDOWS[provider]
    || 8_192
}

// --- Token estimation ---

/** Rough token estimate: ~4 chars per token for English text */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/** Estimate total tokens for a message array */
export function estimateMessagesTokens(messages: Message[]): number {
  let total = 0
  for (const m of messages) {
    // Role + overhead per message (~4 tokens)
    total += 4
    total += estimateTokens(m.text)
    if (m.toolEvents) {
      for (const te of m.toolEvents) {
        total += estimateTokens(te.name) + estimateTokens(te.input)
        if (te.output) total += estimateTokens(te.output)
      }
    }
  }
  return total
}

// --- Context window guard ---

/** Hard minimum: don't even attempt LLM calls below this */
const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000
/** Warn the agent when remaining context is below this */
const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000

export interface ContextWindowGuardResult {
  contextWindowTokens: number
  shouldBlock: boolean
  shouldWarn: boolean
  message: string | null
}

/** Evaluate whether the context window is too small for useful execution */
export function evaluateContextWindowGuard(provider: string, model: string): ContextWindowGuardResult {
  const tokens = getContextWindowSize(provider, model)
  if (tokens < CONTEXT_WINDOW_HARD_MIN_TOKENS) {
    return {
      contextWindowTokens: tokens,
      shouldBlock: true,
      shouldWarn: false,
      message: `Context window too small (${tokens.toLocaleString()} tokens). Minimum required: ${CONTEXT_WINDOW_HARD_MIN_TOKENS.toLocaleString()} tokens.`,
    }
  }
  if (tokens < CONTEXT_WINDOW_WARN_BELOW_TOKENS) {
    return {
      contextWindowTokens: tokens,
      shouldBlock: false,
      shouldWarn: true,
      message: `Small context window (${tokens.toLocaleString()} tokens). Agent may struggle with complex tasks. Consider using a model with a larger context window.`,
    }
  }
  return { contextWindowTokens: tokens, shouldBlock: false, shouldWarn: false, message: null }
}

// --- Context status ---

export interface ContextStatus {
  estimatedTokens: number
  effectiveTokens: number
  contextWindow: number
  percentUsed: number
  messageCount: number
  extraTokens: number
  reserveTokens: number
  remainingTokens: number
  strategy: 'ok' | 'warning' | 'critical'
}

export interface ContextStatusOptions {
  extraTokens?: number
  reserveTokens?: number
}

export function resolveCompactionReserveTokens(provider: string, model: string): number {
  const contextWindow = getContextWindowSize(provider, model)
  if (contextWindow <= 0) return MIN_COMPACTION_RESERVE_TOKENS
  return Math.max(
    MIN_COMPACTION_RESERVE_TOKENS,
    Math.min(DEFAULT_COMPACTION_RESERVE_TOKENS_FLOOR, Math.floor(contextWindow * 0.2)),
  )
}

export function getContextStatus(
  messages: Message[],
  systemPromptTokens: number,
  provider: string,
  model: string,
  options: ContextStatusOptions = {},
): ContextStatus {
  const contextWindow = getContextWindowSize(provider, model)
  const messageTokens = estimateMessagesTokens(messages)
  const extraTokens = Math.max(0, Math.trunc(options.extraTokens || 0))
  const reserveTokens = Math.max(0, Math.trunc(options.reserveTokens || 0))
  const estimatedTokens = messageTokens + systemPromptTokens + extraTokens
  const effectiveTokens = estimatedTokens + reserveTokens
  const percentUsed = Math.round((effectiveTokens / contextWindow) * 100)
  const remainingTokens = Math.max(0, contextWindow - effectiveTokens)
  return {
    estimatedTokens,
    effectiveTokens,
    contextWindow,
    percentUsed,
    messageCount: messages.length,
    extraTokens,
    reserveTokens,
    remainingTokens,
    strategy: percentUsed >= 90 ? 'critical' : percentUsed >= 70 ? 'warning' : 'ok',
  }
}

// --- Context degradation warnings ---

/** Returns a warning string when context usage exceeds thresholds, or null if within safe bounds. */
export function getContextDegradationWarning(
  messages: Message[],
  systemPromptTokens: number,
  provider: string,
  model: string,
  options: ContextStatusOptions = {},
): string | null {
  const status = getContextStatus(messages, systemPromptTokens, provider, model, options)
  const pct = status.percentUsed
  const remaining = status.remainingTokens
  const estTurnsLeft = Math.max(0, Math.floor(remaining / 2000))

  if (pct >= 85) {
    return [
      `[CONTEXT_WARNING] Context window is ${pct}% full (${status.effectiveTokens.toLocaleString()} / ${status.contextWindow.toLocaleString()} effective tokens).`,
      `Estimated remaining capacity: ~${estTurnsLeft} turns.`,
      'CRITICAL: Save essential state to memory immediately. Summarize key findings, decisions, and next steps.',
      'Consider completing the current subtask and storing a checkpoint before context is exhausted.',
    ].join(' ')
  }
  if (pct >= 70) {
    return [
      `[CONTEXT_WARNING] Context window is ${pct}% full.`,
      `Estimated remaining capacity: ~${estTurnsLeft} turns.`,
      'Recommended: Store important progress notes to memory. Prioritize completing high-value subtasks.',
    ].join(' ')
  }
  if (pct >= 60) {
    return [
      `[CONTEXT_WARNING] Context window is ${pct}% full (~${estTurnsLeft} turns remaining).`,
      'Consider saving intermediate state to memory for continuity.',
    ].join(' ')
  }
  return null
}

// --- Memory consolidation ---

/** Extract important facts from old messages before pruning */
export function consolidateToMemory(
  messages: Message[],
  agentId: string | null,
  sessionId: string,
): number {
  if (!agentId) return 0
  const db = getMemoryDb()
  let stored = 0

  for (const m of messages) {
    if (m.role !== 'assistant' || !m.text) continue
    // Look for decisions, commitments, key facts
    const text = m.text
    const hasDecision = /\b(decided|decision|agreed|committed|will do|plan is|approach is|chosen|selected)\b/i.test(text)
    const hasKeyFact = /\b(important|critical|note|remember|key point|constraint|requirement|deadline)\b/i.test(text)
    const hasResult = /\b(result|found|discovered|concluded|completed|built|created|deployed)\b/i.test(text)

    if (hasDecision || hasKeyFact || hasResult) {
      // Create a concise summary (first 500 chars)
      const summary = text.length > 500 ? text.slice(0, 500) + '...' : text
      const category = 'working/scratch'
      const title = `[auto-consolidated] ${text.slice(0, 60).replace(/\n/g, ' ')}`

      db.add({
        agentId,
        sessionId,
        category,
        title,
        content: summary,
        metadata: {
          origin: 'auto-consolidated',
          kind: hasDecision ? 'decision' : hasResult ? 'result' : 'note',
          tier: 'working',
        },
      })
      stored++
    }
  }
  return stored
}

// --- LLM compaction helpers ---

/** Extract recent tool failures from messages for metadata appendix */
export function extractToolFailures(messages: Message[]): string[] {
  const failures: string[] = []
  for (const m of messages) {
    if (!m.toolEvents) continue
    for (const te of m.toolEvents) {
      if (!te.error) continue
      const snippet = (te.output || '').slice(0, MAX_FAILURE_CHARS)
      failures.push(`[${te.name}] error: ${snippet}`)
    }
  }
  return failures.slice(-MAX_TOOL_FAILURES)
}

/** Extract file paths read and modified from tool events */
export function extractFileOperations(messages: Message[]): { read: string[]; modified: string[] } {
  const readSet = new Set<string>()
  const modifiedSet = new Set<string>()

  const READ_TOOLS = new Set(['read_file', 'list_files'])
  const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'copy_file', 'move_file', 'delete_file'])

  for (const m of messages) {
    if (!m.toolEvents) continue
    for (const te of m.toolEvents) {
      let parsed: Record<string, unknown> | null = null
      try { parsed = JSON.parse(te.input) } catch { /* not JSON */ }
      if (!parsed) continue

      const paths: string[] = []
      for (const key of ['filePath', 'sourcePath', 'destinationPath']) {
        const v = parsed[key]
        if (typeof v === 'string' && v) paths.push(v)
      }

      const isRead = READ_TOOLS.has(te.name)
      const isWrite = WRITE_TOOLS.has(te.name)
      for (const p of paths) {
        if (isWrite) modifiedSet.add(p)
        else if (isRead) readSet.add(p)
      }
    }
  }
  return { read: [...readSet], modified: [...modifiedSet] }
}

/** Split messages into chunks that fit within a token budget each */
export function splitMessagesByTokenBudget(messages: Message[], budgetPerChunk: number): Message[][] {
  if (messages.length === 0) return []
  const chunks: Message[][] = []
  let current: Message[] = []
  let currentTokens = 0

  for (const m of messages) {
    const msgTokens = estimateMessagesTokens([m])
    if (current.length > 0 && currentTokens + msgTokens > budgetPerChunk) {
      chunks.push(current)
      current = []
      currentTokens = 0
    }
    current.push(m)
    currentTokens += msgTokens
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Compute adaptive chunk ratio based on average message size. */
export function computeAdaptiveChunkRatio(messages: Message[], contextWindow: number): number {
  if (messages.length === 0) return BASE_CHUNK_RATIO
  const totalTokens = estimateMessagesTokens(messages)
  const avgTokens = totalTokens / messages.length
  const safeAvgTokens = avgTokens * COMPACTION_SAFETY_MARGIN
  const avgRatio = safeAvgTokens / contextWindow

  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO)
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction)
  }
  return BASE_CHUNK_RATIO
}

/** Retry an async function with exponential backoff */
async function retryAsync<T>(fn: () => Promise<T>, maxAttempts = 3, baseMs = 500): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < maxAttempts - 1) {
        const delay = Math.min(baseMs * Math.pow(2, attempt) + Math.random() * 200, 5000)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }
  throw lastError
}

/** Check if a single message is too large for the summarization context */
function isOversizedForSummary(msg: Message, maxChunkTokens: number): boolean {
  return estimateMessagesTokens([msg]) > maxChunkTokens * 0.5
}

/** Summarize in hierarchical stages if context is very large, with retry and oversized message handling */
export async function summarizeInStages(opts: {
  messages: Message[]
  contextWindow: number
  summarize: LLMSummarizer
  maxChunkTokens: number
}): Promise<string> {
  const { messages, summarize, maxChunkTokens } = opts
  const totalTokens = estimateMessagesTokens(messages)

  if (totalTokens <= maxChunkTokens || messages.length < 4) {
    return retryAsync(() => summarize(buildSummarizationPrompt(messages)))
  }

  // Separate oversized messages that would blow a single chunk
  const normalMessages: Message[] = []
  const oversizedMessages: Message[] = []
  for (const m of messages) {
    if (isOversizedForSummary(m, maxChunkTokens)) {
      oversizedMessages.push(m)
    } else {
      normalMessages.push(m)
    }
  }

  const chunks = splitMessagesByTokenBudget(normalMessages, maxChunkTokens)
  if (chunks.length <= 1 && oversizedMessages.length === 0) {
    return retryAsync(() => summarize(buildSummarizationPrompt(messages)))
  }

  const partialSummaries: string[] = []
  for (const chunk of chunks) {
    try {
      const partial = await retryAsync(() => summarize(buildSummarizationPrompt(chunk)))
      if (partial?.trim()) partialSummaries.push(partial.trim())
    } catch { /* skip failed chunk after retries */ }
  }

  // Note oversized messages that were excluded from summarization
  if (oversizedMessages.length > 0) {
    const notes = oversizedMessages.map((m) => {
      const preview = m.text.slice(0, 200).replace(/\n/g, ' ')
      const toolCount = m.toolEvents?.length || 0
      return `- [${m.role}] (oversized, ~${estimateMessagesTokens([m])} tokens${toolCount ? `, ${toolCount} tool calls` : ''}): ${preview}...`
    })
    partialSummaries.push(`## Oversized Messages (excluded from detailed summarization)\n${notes.join('\n')}`)
  }

  if (partialSummaries.length === 0) return 'Summary unavailable.'
  if (partialSummaries.length === 1) return partialSummaries[0]

  return retryAsync(() => summarize(buildMergePrompt(partialSummaries)))
}

/** Build an OpenClaw-aligned summarization prompt for a batch of messages */
function buildSummarizationPrompt(messages: Message[]): string {
  const transcript = messages.map((m) => {
    let line = `[${m.role}]: ${m.text}`
    if (m.toolEvents?.length) {
      for (const te of m.toolEvents) {
        const inp = (te.input || '').slice(0, 500)
        const out = (te.output || '').slice(0, 500)
        line += `\n  tool:${te.name}(${inp})${te.error ? ' [ERROR]' : ''} → ${out}`
      }
    }
    return line
  }).join('\n\n')

  return [
    'Summarize the following conversation transcript into structured notes.',
    '',
    'Rules:',
    '- Preserve all decisions, TODOs, open questions, and any constraints.',
    `- ${IDENTIFIER_PRESERVATION_INSTRUCTIONS}`,
    '- Note errors encountered and their resolutions.',
    '- Keep technical details needed to continue work (versions, configs, commands).',
    '- Aim for 20-40% of original length.',
    '- Use structured notes with bullet points, not narrative prose.',
    '- Group by topic/theme when possible.',
    '',
    '---TRANSCRIPT---',
    transcript,
    '---END TRANSCRIPT---',
  ].join('\n')
}

/** Build a merge prompt for combining multiple partial summaries */
function buildMergePrompt(partialSummaries: string[]): string {
  const numbered = partialSummaries.map((s, i) => `--- Part ${i + 1} ---\n${s}`).join('\n\n')

  return [
    'Merge the following partial conversation summaries into a single cohesive summary.',
    '',
    'Rules:',
    '- Remove redundancy across parts while preserving all important details.',
    `- ${MERGE_SUMMARIES_INSTRUCTIONS}`,
    `- ${IDENTIFIER_PRESERVATION_INSTRUCTIONS}`,
    '- Keep decisions, TODOs, open questions, constraints, and error resolutions.',
    '- Use structured notes with bullet points.',
    '- The result should be shorter than the combined input.',
    '',
    numbered,
  ].join('\n')
}

// --- Compaction strategies ---

export interface CompactionResult {
  messages: Message[]
  prunedCount: number
  memoriesStored: number
  summaryAdded: boolean
}

/** Sliding window: keep last N messages */
export function slidingWindowCompact(
  messages: Message[],
  keepLastN: number,
): Message[] {
  if (messages.length <= keepLastN) return messages
  return messages.slice(-keepLastN)
}

/** LLM-powered compaction: summarize old messages using an LLM, with progressive fallback */
export async function llmCompact(opts: {
  messages: Message[]
  provider: string
  model: string
  agentId: string | null
  sessionId: string
  summarize: LLMSummarizer
  keepLastN?: number
}): Promise<CompactionResult> {
  const { messages, provider, model, agentId, sessionId, summarize, keepLastN = 10 } = opts

  if (messages.length <= keepLastN) {
    return { messages, prunedCount: 0, memoriesStored: 0, summaryAdded: false }
  }

  const repaired = repairTranscriptConsistency(messages)
  const oldMessages = repaired.slice(0, -keepLastN)
  const recentMessages = repaired.slice(-keepLastN)

  // 1. Consolidate important info to memory
  const memoriesStored = consolidateToMemory(oldMessages, agentId, sessionId)

  // 2. Extract metadata
  const toolFailures = extractToolFailures(oldMessages)
  const fileOps = extractFileOperations(oldMessages)

  // 3. Compute adaptive budget
  const contextWindow = getContextWindowSize(provider, model)
  const ratio = computeAdaptiveChunkRatio(oldMessages, contextWindow)
  const chunkBudget = Math.floor((contextWindow / COMPACTION_SAFETY_MARGIN) * ratio) - COMPACTION_OVERHEAD_TOKENS

  // 4. Hierarchical summarization
  let finalSummary: string | null = null
  try {
    finalSummary = await summarizeInStages({
      messages: oldMessages,
      contextWindow,
      summarize,
      maxChunkTokens: Math.max(chunkBudget, 2000),
    })
  } catch {
    finalSummary = null
  }

  // 5. Fall back to sliding window if LLM summarization failed entirely
  if (!finalSummary?.trim()) {
    return {
      messages: slidingWindowCompact(repaired, keepLastN),
      prunedCount: oldMessages.length,
      memoriesStored,
      summaryAdded: false,
    }
  }

  // 6. Append metadata sections
  const metaSections: string[] = [finalSummary.trim()]

  if (toolFailures.length > 0) {
    metaSections.push('\n## Tool Failures\n' + toolFailures.join('\n'))
  }
  if (fileOps.read.length > 0 || fileOps.modified.length > 0) {
    const parts: string[] = []
    if (fileOps.read.length) parts.push('Read: ' + fileOps.read.join(', '))
    if (fileOps.modified.length) parts.push('Modified: ' + fileOps.modified.join(', '))
    metaSections.push('\n## File Operations\n' + parts.join('\n'))
  }

  // 7. Build context summary message
  const summaryMessage: Message = {
    role: 'assistant',
    text: `[Context Summary]\n${metaSections.join('\n')}`,
    time: Date.now(),
    kind: 'system',
  }

  return {
    messages: [summaryMessage, ...recentMessages],
    prunedCount: oldMessages.length,
    memoriesStored,
    summaryAdded: true,
  }
}

/** Summarize old messages, keep recent ones. Delegates to llmCompact for LLM-powered summarization. */
export async function summarizeAndCompact(opts: {
  messages: Message[]
  keepLastN: number
  agentId: string | null
  sessionId: string
  provider: string
  model: string
  generateSummary: LLMSummarizer
}): Promise<CompactionResult> {
  const { messages, keepLastN, agentId, sessionId, provider, model, generateSummary } = opts

  return llmCompact({
    messages,
    provider,
    model,
    agentId,
    sessionId,
    summarize: generateSummary,
    keepLastN,
  })
}

/** Auto-compact: triggers when estimated tokens exceed threshold */
export function shouldAutoCompact(
  messages: Message[],
  systemPromptTokens: number,
  provider: string,
  model: string,
  triggerPercent = 80,
  options: ContextStatusOptions = {},
): boolean {
  const status = getContextStatus(messages, systemPromptTokens, provider, model, {
    ...options,
    reserveTokens: options.reserveTokens ?? resolveCompactionReserveTokens(provider, model),
  })
  return status.percentUsed >= triggerPercent
}
