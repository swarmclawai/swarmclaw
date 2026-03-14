import { HumanMessage } from '@langchain/core/messages'
import { z } from 'zod'
import type { MessageToolEvent } from '@/types'
import { buildLLM } from '@/lib/server/build-llm'

const DirectMemoryIntentResponseSchema = z.object({
  action: z.enum(['none', 'store', 'update', 'recall']),
  confidence: z.number().min(0).max(1).optional(),
  title: z.string().optional().nullable(),
  value: z.string().optional().nullable(),
  query: z.string().optional().nullable(),
  acknowledgement: z.string().optional().nullable(),
  missResponse: z.string().optional().nullable(),
})

export type DirectMemoryIntent =
  | { action: 'none'; confidence: number }
  | { action: 'store'; confidence: number; title?: string; value: string; acknowledgement: string }
  | { action: 'update'; confidence: number; title?: string; value: string; acknowledgement: string }
  | { action: 'recall'; confidence: number; query: string; missResponse: string }

export interface DirectMemoryIntentClassifierInput {
  sessionId: string
  agentId?: string | null
  message: string
  currentResponse?: string | null
  currentError?: string | null
  toolEvents?: MessageToolEvent[]
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function defaultAcknowledgement(action: 'store' | 'update'): string {
  return action === 'update'
    ? 'I\'ll use that updated detail going forward.'
    : 'I\'ll remember that.'
}

function defaultMissResponse(): string {
  return 'I don\'t have that in memory yet.'
}

function fallbackTitle(value: string): string | undefined {
  const trimmed = normalizeText(value)
  if (!trimmed) return undefined
  return trimmed.slice(0, 80)
}

function extractModelText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') ? part.text : '')
    .join('')
}

function extractFirstJsonObject(text: string): string | null {
  const source = normalizeText(text)
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

export function parseDirectMemoryIntentResponse(text: string): DirectMemoryIntent | null {
  const jsonText = extractFirstJsonObject(text)
  if (!jsonText) return null
  let raw: unknown = null
  try {
    raw = JSON.parse(jsonText)
  } catch {
    return null
  }
  const parsed = DirectMemoryIntentResponseSchema.safeParse(raw)
  if (!parsed.success) return null
  const confidence = typeof parsed.data.confidence === 'number' ? parsed.data.confidence : 0
  if (parsed.data.action === 'none') return { action: 'none', confidence }

  if (parsed.data.action === 'store' || parsed.data.action === 'update') {
    const value = normalizeText(parsed.data.value)
    if (!value) return null
    const title = normalizeText(parsed.data.title) || fallbackTitle(value)
    return {
      action: parsed.data.action,
      confidence,
      ...(title ? { title } : {}),
      value,
      acknowledgement: normalizeText(parsed.data.acknowledgement) || defaultAcknowledgement(parsed.data.action),
    }
  }

  const query = normalizeText(parsed.data.query)
  if (!query) return null
  return {
    action: 'recall',
    confidence,
    query,
    missResponse: normalizeText(parsed.data.missResponse) || defaultMissResponse(),
  }
}

function buildDirectMemoryIntentPrompt(input: DirectMemoryIntentClassifierInput): string {
  const message = normalizeText(input.message) || '(empty)'
  const currentResponse = normalizeText(input.currentResponse) || '(none)'
  const currentError = normalizeText(input.currentError) || '(none)'
  const toolCalls = Array.isArray(input.toolEvents) && input.toolEvents.length > 0
    ? input.toolEvents
      .map((event) => {
        const name = normalizeText(event?.name) || 'unknown'
        const inputText = normalizeText(event?.input)
        return inputText ? `${name}(${inputText})` : name
      })
      .join(', ')
    : '(none)'

  return [
    'Classify whether the latest user turn requires a direct durable-memory fallback action.',
    'Return JSON only.',
    '',
    'Rules:',
    '- Choose "store" when the user wants a new durable fact, preference, decision, or profile detail remembered.',
    '- Choose "update" when the user is correcting or replacing previously remembered information.',
    '- Choose "recall" when the user is asking what the assistant remembers from earlier interactions.',
    '- Choose "none" for ordinary conversation, current-thread-only questions, file/code/document work, and anything that should not touch durable memory.',
    '- Be conservative. If unsure, return {"action":"none","confidence":0}.',
    '- For "store" and "update", return the durable fact in "value" and a short natural user-facing acknowledgement in "acknowledgement". Do not mention tools, memory ids, storage, creation, or updating.',
    '- For "recall", return a concise search query in "query" and a short natural "missResponse". Do not mention tools.',
    '',
    'JSON schema:',
    '{"action":"none|store|update|recall","confidence":0-1,"title":"optional short title","value":"for store/update","query":"for recall","acknowledgement":"for store/update","missResponse":"for recall"}',
    '',
    `user_message: ${JSON.stringify(message)}`,
    `assistant_response: ${JSON.stringify(currentResponse)}`,
    `assistant_error: ${JSON.stringify(currentError)}`,
    `tool_calls: ${JSON.stringify(toolCalls)}`,
  ].join('\n')
}

export async function classifyDirectMemoryIntent(
  input: DirectMemoryIntentClassifierInput,
  options?: {
    generateText?: (prompt: string) => Promise<string>
  },
): Promise<DirectMemoryIntent | null> {
  const prompt = buildDirectMemoryIntentPrompt(input)
  const responseText = options?.generateText
    ? await options.generateText(prompt)
    : await (async () => {
      const { llm } = await buildLLM({
        sessionId: input.sessionId,
        agentId: input.agentId || null,
      })
      const response = await llm.invoke([new HumanMessage(prompt)])
      return extractModelText(response.content)
    })()
  return parseDirectMemoryIntentResponse(responseText)
}

function splitFirstMemoryLine(toolOutput: string): string | null {
  for (const rawLine of String(toolOutput || '').split('\n')) {
    const line = rawLine.trim()
    if (line) return line
  }
  return null
}

export function renderMemoryContent(content: string): string {
  const trimmed = normalizeText(content)
  if (!trimmed) return ''
  const lower = trimmed.toLowerCase()
  const candidates = [
    { prefix: 'my ', subjectOffset: 3 },
    { prefix: "user's ", subjectOffset: 7 },
    { prefix: 'users ', subjectOffset: 6 },
  ]
  for (const candidate of candidates) {
    if (!lower.startsWith(candidate.prefix)) continue
    const separator = lower.indexOf(' is ')
    if (separator <= candidate.subjectOffset) continue
    const subject = trimmed.slice(candidate.subjectOffset, separator).trim()
    const value = trimmed.slice(separator + 4).trim().replace(/[.?!\s]+$/g, '')
    if (subject && value) return `Your ${subject} is ${value}.`
  }
  return /[.?!]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

export function buildDirectMemoryRecallResponse(
  intent: Extract<DirectMemoryIntent, { action: 'recall' }>,
  toolOutput: string,
): string | null {
  const firstLine = splitFirstMemoryLine(toolOutput)
  if (!firstLine) return null
  if (firstLine === 'No memories found.') return intent.missResponse
  const contentIndex = firstLine.indexOf(': ')
  if (contentIndex === -1) return null
  const content = firstLine.slice(contentIndex + 2).trim()
  if (!content) return null
  return renderMemoryContent(content)
}
