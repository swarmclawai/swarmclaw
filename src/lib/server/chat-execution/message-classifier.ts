/**
 * LLM-based message classifier that replaces hardcoded semantic regex.
 *
 * Makes a single structured LLM call per turn to classify the user message
 * across all semantic dimensions currently spread across regex patterns in
 * stream-continuation.ts, prompt-builder.ts, chat-streaming-utils.ts, and
 * supervisor-reflection.ts.
 *
 * Follows the same pattern as direct-memory-intent.ts: Zod schema, buildLLM,
 * optional generateText override for testing.
 */
import crypto from 'node:crypto'
import { HumanMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { buildLLM } from '@/lib/server/build-llm'
import { hmrSingleton } from '@/lib/shared-utils'
import type { Message } from '@/types'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const MessageClassificationSchema = z.object({
  isDeliverableTask: z.boolean(),
  isBroadGoal: z.boolean(),
  walletIntent: z.enum(['none', 'read_only', 'transactional']),
  hasHumanSignals: z.boolean(),
  hasSignificantEvent: z.boolean(),
  isResearchSynthesis: z.boolean(),
  explicitToolRequests: z.array(z.string()),
  confidence: z.number().min(0).max(1),
})

export type MessageClassification = z.infer<typeof MessageClassificationSchema>

// ---------------------------------------------------------------------------
// LRU Cache (module-level, keyed on sha256 of message)
// ---------------------------------------------------------------------------

const MAX_CACHE_SIZE = 200
const classificationCache = hmrSingleton('__swarmclaw_classification_cache__', () => new Map<string, MessageClassification>())

function cacheKey(message: string): string {
  return crypto.createHash('sha256').update(message).digest('hex')
}

function getCached(message: string): MessageClassification | null {
  const key = cacheKey(message)
  const cached = classificationCache.get(key)
  if (!cached) return null
  // LRU refresh: delete and re-insert so it stays at the end
  classificationCache.delete(key)
  classificationCache.set(key, cached)
  return cached
}

function setCache(message: string, classification: MessageClassification): void {
  const key = cacheKey(message)
  if (classificationCache.size >= MAX_CACHE_SIZE) {
    // Evict the oldest entry (first key)
    const oldest = classificationCache.keys().next().value
    if (oldest !== undefined) classificationCache.delete(oldest)
  }
  classificationCache.set(key, classification)
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildClassificationPrompt(message: string, recentHistory: string): string {
  return [
    'Classify the user message below across multiple dimensions. Return JSON only.',
    '',
    'Dimensions:',
    '- isDeliverableTask (bool): The user wants a concrete artifact produced — a document, report, plan, proposal, landing page, dashboard, HTML file, markdown file, brief, copy, screenshots, or similar deliverable. NOT simple Q&A, code fixes, or single-command tasks.',
    '- isBroadGoal (bool): The message describes a broad, multi-step goal (50+ chars, no code blocks, no file paths, no numbered lists). Short questions ending with "?" are NOT broad goals.',
    '- walletIntent: "none" if no crypto/wallet/trading context. "read_only" if mentioning wallet/crypto but only for checking balances, viewing transactions, or research. "transactional" if the user wants to swap, trade, buy, sell, mint, claim, deposit, withdraw, bridge, or execute a transaction.',
    '- hasHumanSignals (bool): The message contains personal signals — preferences ("I prefer", "call me"), relationships ("my wife", "my partner", "my kid"), life events ("birthday", "wedding", "promotion", "moving", "graduation", "hospital"), or personal disclosures.',
    '- hasSignificantEvent (bool): The message mentions a notable life/work event or milestone (birthday, anniversary, wedding, graduation, promotion, new job, relocation, illness, funeral, travel, house, deadline, launch).',
    '- isResearchSynthesis (bool): The task requires gathering information from multiple sources and synthesizing it — research reports, competitive analysis, market overviews, literature reviews, multi-source comparisons. NOT simple factual lookups.',
    '- explicitToolRequests (string[]): Tool names the user explicitly asks to use. E.g. "use the shell", "run curl", "send an email", "ask the human", "use the browser". Return canonical tool names: "shell", "email", "ask_human", "browser", "files", "web". Empty array if none.',
    '- confidence (0-1): How confident are you in this classification overall.',
    '',
    'Rules:',
    '- Be conservative. When unsure, default to false/none/empty.',
    '- A message can be both a deliverable task AND a broad goal.',
    '- "walletIntent" should be "transactional" only if the user wants to execute a state-changing action, not just discuss crypto.',
    '- For "explicitToolRequests", only include tools the user explicitly mentions by name or clear synonym. Do not infer tool needs from the task type.',
    '',
    'Output shape:',
    '{"isDeliverableTask":bool,"isBroadGoal":bool,"walletIntent":"none|read_only|transactional","hasHumanSignals":bool,"hasSignificantEvent":bool,"isResearchSynthesis":bool,"explicitToolRequests":[],"confidence":0.0-1.0}',
    '',
    recentHistory ? `Recent context:\n${recentHistory}\n` : '',
    `User message: ${JSON.stringify(message)}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// JSON extraction (same approach as direct-memory-intent.ts)
// ---------------------------------------------------------------------------

function extractFirstJsonObject(text: string): string | null {
  const source = text.trim()
  if (!source) return null
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (start === -1) {
      if (char === '{') {
        start = index
        depth = 1
      }
      continue
    }
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }
  return null
}

function extractModelText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') ? part.text : '')
    .join('')
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseClassificationResponse(text: string): MessageClassification | null {
  const jsonText = extractFirstJsonObject(text)
  if (!jsonText) return null
  let raw: unknown = null
  try {
    raw = JSON.parse(jsonText)
  } catch {
    return null
  }
  const parsed = MessageClassificationSchema.safeParse(raw)
  if (!parsed.success) return null
  return parsed.data
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ClassifyMessageInput {
  sessionId: string
  agentId?: string | null
  message: string
  history?: Message[]
}

const CLASSIFIER_TIMEOUT_MS = 2_000

/**
 * Classify a user message using a single LLM call.
 * Returns null on failure/timeout — callers should fall back to regex.
 */
export async function classifyMessage(
  input: ClassifyMessageInput,
  options?: { generateText?: (prompt: string) => Promise<string> },
): Promise<MessageClassification | null> {
  const message = input.message.trim()
  if (!message) return null

  // Check cache first
  const cached = getCached(message)
  if (cached) return cached

  // Build recent history context (last 2 user messages for context)
  const recentHistory = Array.isArray(input.history)
    ? input.history
        .filter((m) => m.role === 'user' && typeof m.text === 'string' && m.text.trim())
        .slice(-2)
        .map((m) => `- ${(m.text || '').trim().slice(0, 200)}`)
        .join('\n')
    : ''

  const prompt = buildClassificationPrompt(message, recentHistory)

  const startMs = Date.now()
  try {
    const responseText = await Promise.race([
      options?.generateText
        ? options.generateText(prompt)
        : (async () => {
            const { llm } = await buildLLM({
              sessionId: input.sessionId,
              agentId: input.agentId || null,
            })
            const response = await llm.invoke([new HumanMessage(prompt)])
            return extractModelText(response.content)
          })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('classifier-timeout')), CLASSIFIER_TIMEOUT_MS),
      ),
    ])

    const durationMs = Date.now() - startMs
    console.log(`[message-classifier] session=${input.sessionId} completed in ${durationMs}ms`)

    const classification = parseClassificationResponse(responseText)
    if (classification) {
      setCache(message, classification)
    }
    return classification
  } catch (err: unknown) {
    const durationMs = Date.now() - startMs
    console.warn(`[message-classifier] session=${input.sessionId} failed in ${durationMs}ms: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Adapter functions — fall back to regex when classification is null
// ---------------------------------------------------------------------------

import {
  isBroadGoal as regexIsBroadGoal,
  looksLikeExternalWalletTask as regexLooksLikeExternalWalletTask,
  looksLikeBoundedExternalExecutionTask as regexLooksLikeBoundedExternalExecutionTask,
  looksLikeOpenEndedDeliverableTask as regexLooksLikeOpenEndedDeliverableTask,
} from '@/lib/server/chat-execution/stream-continuation'

export function isDeliverableTask(classification: MessageClassification | null, message: string): boolean {
  return classification?.isDeliverableTask ?? regexLooksLikeOpenEndedDeliverableTask(message)
}

export function isBroadGoal(classification: MessageClassification | null, message: string): boolean {
  return classification?.isBroadGoal ?? regexIsBroadGoal(message)
}

export function hasWalletIntent(classification: MessageClassification | null, message: string): boolean {
  if (classification) return classification.walletIntent !== 'none'
  return regexLooksLikeExternalWalletTask(message)
}

export function hasTransactionalWalletIntent(classification: MessageClassification | null, message: string): boolean {
  if (classification) return classification.walletIntent === 'transactional'
  return regexLooksLikeBoundedExternalExecutionTask(message)
}

export function hasHumanSignals(classification: MessageClassification | null, transcript: string): boolean {
  if (classification) return classification.hasHumanSignals
  // Fallback to regex
  return /\b(?:prefer|please|call me|don't call me|do not call me|i like|i dislike|i hate|i love|my pronouns|my partner|my wife|my husband|my kid|my child|my mom|my dad|my sister|my brother|birthday|anniversary|wedding|married|divorc|pregnan|baby|moved|moving|relocat|promotion|promoted|laid off|new job|job change|graduat|hospital|sick|illness|diagnos|passed away|funeral|grief|bereave|deadline|launch|fundraising|closing|house|home|travel)\b/i.test(transcript)
}

export function hasSignificantEvent(classification: MessageClassification | null, text: string): boolean {
  if (classification) return classification.hasSignificantEvent
  return /\b(?:birthday|anniversary|wedding|married|divorc|pregnan|baby|moved|moving|relocat|promotion|promoted|laid off|new job|job change|graduat|hospital|sick|illness|diagnos|passed away|funeral|grief|bereave|deadline|launch|fundraising|closing|house|home|travel)\b/i.test(text)
}

export function isResearchSynthesis(classification: MessageClassification | null, routingIntent: string | null): boolean {
  if (classification) return classification.isResearchSynthesis
  return routingIntent === 'research' || routingIntent === 'browsing'
}
