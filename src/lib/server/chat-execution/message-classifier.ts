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
import { log } from '@/lib/server/logger'
import { hmrSingleton } from '@/lib/shared-utils'
import type { Message, MessageSemanticsSummary, MessageTaskIntent } from '@/types'
import type { DelegationWorkType } from '@/lib/server/agents/delegation-advisory'

const TAG = 'message-classifier'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const WorkTypeSchema = z.enum(['coding', 'research', 'writing', 'review', 'operations', 'general']).optional().default('general')
const TaskIntentSchema = z.enum(['coding', 'research', 'browsing', 'outreach', 'scheduling', 'general']).optional().default('general')

export const MessageClassificationSchema = z.object({
  taskIntent: TaskIntentSchema,
  isDeliverableTask: z.boolean(),
  isBroadGoal: z.boolean(),
  isLightweightDirectChat: z.boolean().optional().default(false),
  hasHumanSignals: z.boolean(),
  hasSignificantEvent: z.boolean(),
  isResearchSynthesis: z.boolean(),
  workType: WorkTypeSchema,
  wantsScreenshots: z.boolean().optional().default(false),
  wantsOutboundDelivery: z.boolean().optional().default(false),
  wantsVoiceDelivery: z.boolean().optional().default(false),
  explicitToolRequests: z.array(z.string()),
  confidence: z.number().min(0).max(1),
})

export interface MessageClassification {
  taskIntent: MessageTaskIntent
  isDeliverableTask: boolean
  isBroadGoal: boolean
  isLightweightDirectChat?: boolean
  hasHumanSignals: boolean
  hasSignificantEvent: boolean
  isResearchSynthesis: boolean
  workType?: DelegationWorkType
  wantsScreenshots?: boolean
  wantsOutboundDelivery?: boolean
  wantsVoiceDelivery?: boolean
  explicitToolRequests: string[]
  confidence: number
}

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
    '- taskIntent: The primary execution intent. Use exactly one of: "coding", "research", "browsing", "outreach", "scheduling", or "general". Choose "coding" for repo/code/build/debug/edit tasks. Choose "research" for gathering current info or synthesizing sources. Choose "browsing" for page navigation, rendered-page inspection, form work, or literal browser workflows. Choose "outreach" for sending/sharing/delivering updates to an external channel. Choose "scheduling" for reminders, recurring work, monitoring, or follow-up scheduling. Choose "general" when none of the above clearly fits.',
    '- isDeliverableTask (bool): The user wants a concrete artifact produced — a document, report, plan, proposal, landing page, dashboard, HTML file, markdown file, brief, copy, screenshots, or similar deliverable. NOT simple Q&A, code fixes, or single-command tasks.',
    '- isBroadGoal (bool): The message describes a broad, multi-step goal (50+ chars, no code blocks, no file paths, no numbered lists). Short questions ending with "?" are NOT broad goals.',
    '- isLightweightDirectChat (bool): This is a low-signal direct chat turn that should get a natural lightweight reply, such as a greeting, acknowledgment, check-in, or simple social/direct question that does NOT require research, file work, planning, delegation, or tool execution.',
    '- hasHumanSignals (bool): The message contains personal signals — preferences ("I prefer", "call me"), relationships ("my wife", "my partner", "my kid"), life events ("birthday", "wedding", "promotion", "moving", "graduation", "hospital"), or personal disclosures.',
    '- hasSignificantEvent (bool): The message mentions a notable life/work event or milestone (birthday, anniversary, wedding, graduation, promotion, new job, relocation, illness, funeral, travel, house, deadline, launch).',
    '- isResearchSynthesis (bool): The task requires gathering information from multiple sources and synthesizing it — research reports, competitive analysis, market overviews, literature reviews, multi-source comparisons. NOT simple factual lookups.',
    '- workType: The primary work domain. Use exactly one of: "coding", "research", "writing", "review", "operations", or "general". Choose "general" when nothing else clearly fits.',
    '- wantsScreenshots (bool): The user explicitly wants screenshots, visual capture, rendered proof, or page snapshots.',
    '- wantsOutboundDelivery (bool): The user explicitly wants the result sent, shared, delivered, posted, or messaged to an external destination/channel.',
    '- wantsVoiceDelivery (bool): The user explicitly wants a voice note, voice memo, audio note, or voice message.',
    '- explicitToolRequests (string[]): Tool names the user explicitly asks to use. E.g. "use the shell", "run curl", "send an email", "ask the human", "use the browser". Return canonical tool names: "shell", "email", "ask_human", "browser", "files", "web". Empty array if none.',
    '- confidence (0-1): How confident are you in this classification overall.',
    '',
    'Rules:',
    '- Be conservative. When unsure, default to false/none/empty.',
    '- Mark isLightweightDirectChat true only when a short natural reply is enough and escalating into planning, delegation, or tool execution would be unnecessary.',
    '- A message can be both a deliverable task AND a broad goal.',
    '- For "explicitToolRequests", only include tools the user explicitly mentions by name or clear synonym. Do not infer tool needs from the task type.',
    '- Prefer the most execution-relevant taskIntent. Example: "research this and send me a voice note" is "research", not "outreach".',
    '',
    'Output shape:',
    '{"taskIntent":"coding|research|browsing|outreach|scheduling|general","isDeliverableTask":bool,"isBroadGoal":bool,"isLightweightDirectChat":bool,"hasHumanSignals":bool,"hasSignificantEvent":bool,"isResearchSynthesis":bool,"workType":"coding|research|writing|review|operations|general","wantsScreenshots":bool,"wantsOutboundDelivery":bool,"wantsVoiceDelivery":bool,"explicitToolRequests":[],"confidence":0.0-1.0}',
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
 * Returns null on failure/timeout so callers can fail open to neutral behavior.
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
    log.info(TAG, `session=${input.sessionId} completed in ${durationMs}ms`)

    const classification = parseClassificationResponse(responseText)
    if (classification) {
      setCache(message, classification)
    }
    return classification
  } catch (err: unknown) {
    const durationMs = Date.now() - startMs
    log.warn(TAG, `session=${input.sessionId} failed in ${durationMs}ms: ${err instanceof Error ? err.message : 'unknown'}`)
    return null
  }
}

export function toMessageSemanticsSummary(classification: MessageClassification | null | undefined): MessageSemanticsSummary | undefined {
  if (!classification) return undefined
  return {
    taskIntent: classification.taskIntent,
    workType: classification.workType || 'general',
    isDeliverableTask: classification.isDeliverableTask,
    isBroadGoal: classification.isBroadGoal,
    isResearchSynthesis: classification.isResearchSynthesis,
    isLightweightDirectChat: classification.isLightweightDirectChat === true,
    hasHumanSignals: classification.hasHumanSignals,
    hasSignificantEvent: classification.hasSignificantEvent,
    wantsScreenshots: classification.wantsScreenshots === true,
    wantsOutboundDelivery: classification.wantsOutboundDelivery === true,
    wantsVoiceDelivery: classification.wantsVoiceDelivery === true,
    explicitToolRequests: [...classification.explicitToolRequests],
    confidence: classification.confidence,
  }
}

// ---------------------------------------------------------------------------
// Adapter functions — neutral defaults when classification is unavailable
// ---------------------------------------------------------------------------

export function isDeliverableTask(classification: MessageClassification | null, message?: string): boolean {
  void message
  return classification?.isDeliverableTask === true
}

export function isBroadGoal(classification: MessageClassification | null, message?: string): boolean {
  void message
  return classification?.isBroadGoal === true
}

export function hasHumanSignals(classification: MessageClassification | null, transcript?: string): boolean {
  void transcript
  return classification?.hasHumanSignals === true
}

export function hasSignificantEvent(classification: MessageClassification | null, text?: string): boolean {
  void text
  return classification?.hasSignificantEvent === true
}

export function isResearchSynthesis(classification: MessageClassification | null, routingIntent?: string | null): boolean {
  void routingIntent
  return classification?.isResearchSynthesis === true
}

export function isLightweightDirectChat(classification: MessageClassification | null, message?: string): boolean {
  void message
  return classification?.isLightweightDirectChat === true
}
