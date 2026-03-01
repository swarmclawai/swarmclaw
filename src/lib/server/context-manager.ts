import type { Message, ProviderType } from '@/types'
import { getMemoryDb } from './memory-db'

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

// --- Context status ---

export interface ContextStatus {
  estimatedTokens: number
  contextWindow: number
  percentUsed: number
  messageCount: number
  strategy: 'ok' | 'warning' | 'critical'
}

export function getContextStatus(
  messages: Message[],
  systemPromptTokens: number,
  provider: string,
  model: string,
): ContextStatus {
  const contextWindow = getContextWindowSize(provider, model)
  const messageTokens = estimateMessagesTokens(messages)
  const estimatedTokens = messageTokens + systemPromptTokens
  const percentUsed = Math.round((estimatedTokens / contextWindow) * 100)
  return {
    estimatedTokens,
    contextWindow,
    percentUsed,
    messageCount: messages.length,
    strategy: percentUsed >= 90 ? 'critical' : percentUsed >= 70 ? 'warning' : 'ok',
  }
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
      const category = hasDecision ? 'decision' : hasResult ? 'result' : 'note'
      const title = `[auto-consolidated] ${text.slice(0, 60).replace(/\n/g, ' ')}`

      db.add({
        agentId,
        sessionId,
        category,
        title,
        content: summary,
      })
      stored++
    }
  }
  return stored
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

/** Summarize old messages, keep recent ones */
export async function summarizeAndCompact(opts: {
  messages: Message[]
  keepLastN: number
  agentId: string | null
  sessionId: string
  generateSummary: (text: string) => Promise<string>
}): Promise<CompactionResult> {
  const { messages, keepLastN, agentId, sessionId, generateSummary } = opts
  if (messages.length <= keepLastN) {
    return { messages, prunedCount: 0, memoriesStored: 0, summaryAdded: false }
  }

  const oldMessages = messages.slice(0, -keepLastN)
  const recentMessages = messages.slice(-keepLastN)

  // Consolidate important info to memory before pruning
  const memoriesStored = consolidateToMemory(oldMessages, agentId, sessionId)

  // Build text for summarization
  const conversationText = oldMessages
    .map((m) => `${m.role}: ${m.text}`)
    .join('\n\n')

  const summary = await generateSummary(conversationText)

  const summaryMessage: Message = {
    role: 'assistant',
    text: `[Context Summary]\n${summary}`,
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

/** Auto-compact: triggers when estimated tokens exceed threshold */
export function shouldAutoCompact(
  messages: Message[],
  systemPromptTokens: number,
  provider: string,
  model: string,
  triggerPercent = 80,
): boolean {
  const status = getContextStatus(messages, systemPromptTokens, provider, model)
  return status.percentUsed >= triggerPercent
}
