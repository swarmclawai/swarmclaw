import type { Session } from '@/types'
import { getProvider, streamChatWithFailover } from '@/lib/providers'
import { decryptKey, loadCredentials } from './storage'
import { extractDocumentArtifact, type DocumentArtifact } from './document-utils'

type JsonSchemaLike = Record<string, unknown>

interface ExtractionSession extends Pick<Session, 'id' | 'provider' | 'model' | 'credentialId' | 'fallbackCredentialIds' | 'apiEndpoint' | 'thinkingLevel'> {
  name?: string
  cwd?: string
}

export interface StructuredExtractionSource {
  kind: 'text' | 'file' | 'mixed'
  text: string
  filePath?: string | null
  artifact?: DocumentArtifact | null
}

export interface StructuredExtractionResult {
  object: unknown
  raw: string
  validationErrors: string[]
  provider: string
  model: string
  source: StructuredExtractionSource
}

function resolveApiKey(session: ExtractionSession): string | null {
  const provider = getProvider(session.provider)
  if (!provider) throw new Error(`Unknown provider: ${session.provider}`)
  if (provider.requiresApiKey) {
    if (!session.credentialId) throw new Error('No API key configured for this session')
    const creds = loadCredentials()
    const cred = creds[session.credentialId]
    if (!cred?.encryptedKey) throw new Error('API key not found. Please add one in Settings.')
    return decryptKey(cred.encryptedKey)
  }
  if (provider.optionalApiKey && session.credentialId) {
    const creds = loadCredentials()
    const cred = creds[session.credentialId]
    if (cred?.encryptedKey) {
      try {
        return decryptKey(cred.encryptedKey)
      } catch {
        return null
      }
    }
  }
  return null
}

function normalizeSchemaInput(schema: unknown): JsonSchemaLike {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) return schema as JsonSchemaLike
  if (typeof schema === 'string' && schema.trim()) {
    const parsed = JSON.parse(schema)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as JsonSchemaLike
  }
  throw new Error('schema must be a JSON object or a JSON string representing an object.')
}

function defaultSummarySchema(): JsonSchemaLike {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      keyPoints: { type: 'array', items: { type: 'string' } },
      entities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string' },
            value: {},
          },
          required: ['name'],
        },
      },
    },
    required: ['summary', 'keyPoints'],
  }
}

function normalizeText(value: string, maxChars = 120_000): string {
  const cleaned = value.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim()
  if (cleaned.length <= maxChars) return cleaned
  return `${cleaned.slice(0, maxChars)}\n\n[... truncated ...]`
}

function extractJsonBlock(text: string): string | null {
  const raw = (text || '').trim()
  if (!raw) return null

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  if (fenced) return fenced

  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    return raw
  }

  let inString = false
  let escaped = false
  let start = -1
  const stack: string[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') {
      if (stack.length === 0) start = index
      stack.push(char)
      continue
    }
    if (char === '}' || char === ']') {
      const last = stack.at(-1)
      if ((char === '}' && last === '{') || (char === ']' && last === '[')) {
        stack.pop()
        if (stack.length === 0 && start >= 0) {
          return raw.slice(start, index + 1)
        }
      }
    }
  }

  return null
}

function parseModelJson(text: string): unknown {
  const candidate = extractJsonBlock(text)
  if (!candidate) throw new Error('Model did not return JSON.')
  return JSON.parse(candidate)
}

function typeMatches(value: unknown, expected: string): boolean {
  if (expected === 'array') return Array.isArray(value)
  if (expected === 'object') return !!value && typeof value === 'object' && !Array.isArray(value)
  if (expected === 'string') return typeof value === 'string'
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (expected === 'boolean') return typeof value === 'boolean'
  if (expected === 'null') return value === null
  return true
}

function validateJsonLikeSchema(
  value: unknown,
  schema: JsonSchemaLike,
  path = '$',
  errors: string[] = [],
): string[] {
  const expected = schema.type
  if (typeof expected === 'string' && !typeMatches(value, expected)) {
    errors.push(`${path} should be ${expected}`)
    return errors
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
    errors.push(`${path} must be one of the allowed enum values`)
  }

  if (expected === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const asRecord = value as Record<string, unknown>
    const properties = (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties))
      ? schema.properties as Record<string, JsonSchemaLike>
      : {}
    const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : []
    for (const key of required) {
      if (!(key in asRecord)) errors.push(`${path}.${key} is required`)
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in asRecord)) continue
      validateJsonLikeSchema(asRecord[key], childSchema, `${path}.${key}`, errors)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(asRecord)) {
        if (!(key in properties)) errors.push(`${path}.${key} is not allowed`)
      }
    }
  }

  if (expected === 'array' && Array.isArray(value)) {
    const itemSchema = (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items))
      ? schema.items as JsonSchemaLike
      : null
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} items`)
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path} must contain at most ${schema.maxItems} items`)
    }
    if (itemSchema) {
      value.slice(0, 100).forEach((entry, index) => validateJsonLikeSchema(entry, itemSchema, `${path}[${index}]`, errors))
    }
  }

  return errors
}

async function callExtractionModel(params: {
  session: ExtractionSession
  prompt: string
}): Promise<string> {
  const provider = getProvider(params.session.provider)
  if (!provider) throw new Error(`Unknown provider: ${params.session.provider}`)

  const apiKey = resolveApiKey(params.session)
  const streamedText: string[] = []
  const streamedErrors: string[] = []

  const raw = await streamChatWithFailover({
    session: {
      id: `${params.session.id}:extract:${Date.now()}`,
      provider: params.session.provider,
      model: params.session.model,
      credentialId: params.session.credentialId ?? null,
      fallbackCredentialIds: params.session.fallbackCredentialIds || [],
      apiEndpoint: params.session.apiEndpoint || undefined,
      thinkingLevel: params.session.thinkingLevel,
    },
    message: params.prompt,
    apiKey,
    active: new Map(),
    loadHistory: () => [],
    write: (chunk) => {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          const event = JSON.parse(line.slice(6).trim()) as Record<string, unknown>
          if (event.t === 'd' && typeof event.text === 'string') streamedText.push(event.text)
          if (event.t === 'err' && typeof event.text === 'string') streamedErrors.push(event.text)
        } catch {
          // ignore malformed SSE fragments
        }
      }
    },
  })

  const text = (raw || streamedText.join('')).trim()
  if (!text) {
    throw new Error(streamedErrors[0] || `Provider "${provider.name}" returned no content.`)
  }
  return text
}

function buildExtractionPrompt(params: {
  instruction?: string | null
  schema: JsonSchemaLike
  source: StructuredExtractionSource
}): string {
  const parts = [
    'Extract structured data from the provided source.',
    'Return only valid JSON. Do not include markdown fences, commentary, or explanatory text.',
    'If a field cannot be determined, use null, an empty string, or an empty array based on the schema.',
  ]
  if (params.instruction?.trim()) {
    parts.push(`Task:\n${params.instruction.trim()}`)
  }
  parts.push(`JSON Schema:\n${JSON.stringify(params.schema, null, 2)}`)
  if (params.source.artifact) {
    const artifact = params.source.artifact
    parts.push(`Source metadata:\n${JSON.stringify({
      filePath: artifact.filePath,
      fileName: artifact.fileName,
      ext: artifact.ext,
      method: artifact.method,
      metadata: artifact.metadata,
      tableCount: artifact.tables.length,
    }, null, 2)}`)
  }
  parts.push(`Source text:\n${params.source.text}`)
  return parts.join('\n\n')
}

async function prepareSource(params: {
  text?: string | null
  filePath?: string | null
  preferOcr?: boolean
  maxChars?: number
}): Promise<StructuredExtractionSource> {
  const chunks: string[] = []
  let artifact: DocumentArtifact | null = null

  if (params.filePath) {
    artifact = await extractDocumentArtifact(params.filePath, {
      preferOcr: params.preferOcr,
      maxChars: params.maxChars,
    })
    if (artifact.text.trim()) chunks.push(artifact.text)
  }

  if (params.text?.trim()) chunks.push(params.text.trim())
  if (chunks.length === 0) throw new Error('text or filePath is required.')

  return {
    kind: params.filePath && params.text ? 'mixed' : params.filePath ? 'file' : 'text',
    filePath: params.filePath || null,
    artifact,
    text: normalizeText(chunks.join('\n\n'), params.maxChars || 120_000),
  }
}

export async function runStructuredExtraction(params: {
  session: ExtractionSession
  text?: string | null
  filePath?: string | null
  instruction?: string | null
  schema?: unknown
  preferOcr?: boolean
  maxChars?: number
}): Promise<StructuredExtractionResult> {
  if (!params.session.provider || !params.session.model) {
    throw new Error('Current session is missing provider/model configuration.')
  }

  const source = await prepareSource({
    text: params.text,
    filePath: params.filePath,
    preferOcr: params.preferOcr,
    maxChars: params.maxChars,
  })
  const schema = params.schema === undefined ? defaultSummarySchema() : normalizeSchemaInput(params.schema)
  const prompt = buildExtractionPrompt({
    instruction: params.instruction,
    schema,
    source,
  })

  let raw = await callExtractionModel({
    session: params.session,
    prompt,
  })

  let parsed: unknown
  try {
    parsed = parseModelJson(raw)
  } catch {
    raw = await callExtractionModel({
      session: params.session,
      prompt: [
        'Repair the invalid JSON below so it becomes valid JSON that matches the provided schema.',
        'Return only JSON.',
        `JSON Schema:\n${JSON.stringify(schema, null, 2)}`,
        `Invalid output:\n${raw}`,
      ].join('\n\n'),
    })
    parsed = parseModelJson(raw)
  }

  const validationErrors = validateJsonLikeSchema(parsed, schema).slice(0, 50)
  return {
    object: parsed,
    raw,
    validationErrors,
    provider: params.session.provider,
    model: params.session.model,
    source,
  }
}
