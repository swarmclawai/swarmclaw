import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { loadSettings } from '../storage'
import type { ToolBuildContext } from './context'

interface ReplicateConfig {
  apiToken: string
  defaultModel: string
  pollingIntervalMs: number
  timeoutMs: number
}

function getConfig(): ReplicateConfig {
  const settings = loadSettings()
  const ps = (settings.pluginSettings as Record<string, Record<string, unknown>> | undefined)?.replicate ?? {}
  return {
    apiToken: (ps.apiToken as string) || '',
    defaultModel: (ps.defaultModel as string) || '',
    pollingIntervalMs: Number(ps.pollingIntervalMs) || 2000,
    timeoutMs: Number(ps.timeoutMs) || 120000,
  }
}

const API_BASE = 'https://api.replicate.com/v1'

async function replicateRequest(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...extraHeaders,
  }
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(15_000),
  }
  if (body && method !== 'GET' && method !== 'DELETE') {
    init.body = JSON.stringify(body)
  }
  const res = await fetch(`${API_BASE}${path}`, init)
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    return { ok: false, error: `Replicate ${res.status}: ${errText.slice(0, 400)}` }
  }
  const data = await res.json()
  return { ok: true, data }
}

function formatPrediction(p: Record<string, unknown>): Record<string, unknown> {
  return {
    id: p.id,
    model: p.model,
    status: p.status,
    output: p.output,
    error: p.error,
    logs: typeof p.logs === 'string' ? p.logs.slice(-500) : undefined,
    metrics: p.metrics,
    created_at: p.created_at,
    started_at: p.started_at,
    completed_at: p.completed_at,
  }
}

async function pollPrediction(token: string, predictionId: string, cfg: ReplicateConfig): Promise<Record<string, unknown>> {
  const deadline = Date.now() + cfg.timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, cfg.pollingIntervalMs))
    const r = await replicateRequest('GET', `/predictions/${predictionId}`, token)
    if (!r.ok) return { status: 'failed', error: r.error }
    const prediction = r.data as Record<string, unknown>
    if (prediction.status === 'succeeded' || prediction.status === 'failed' || prediction.status === 'canceled') {
      return prediction
    }
  }
  return { status: 'failed', error: 'Prediction timed out.' }
}

async function executeReplicate(args: Record<string, unknown>): Promise<string> {
  const normalized = normalizeToolInputArgs(args)
  const action = String(normalized.action || 'run')
  const cfg = getConfig()

  if (!cfg.apiToken) {
    return 'Error: Replicate API token not configured. Ask the user to add it in Plugin Settings > Replicate.'
  }

  try {
    switch (action) {
      case 'run': {
        const model = String(normalized.model || cfg.defaultModel || '').trim()
        if (!model) return 'Error: "model" is required (e.g. "stability-ai/sdxl", "meta/llama-2-70b-chat").'

        const input = (normalized.input as Record<string, unknown>) || {}
        if (typeof normalized.prompt === 'string') {
          input.prompt = normalized.prompt
        }

        const version = typeof normalized.version === 'string' ? normalized.version.trim() : undefined

        // Build request body
        const body: Record<string, unknown> = { input }
        if (version) {
          body.version = version
        } else {
          body.model = model
        }

        // Try sync mode first (Prefer: wait blocks up to 60s)
        const r = await replicateRequest('POST', '/predictions', cfg.apiToken, body, { Prefer: 'wait' })
        if (!r.ok) return `Error: ${r.error}`

        let prediction = r.data as Record<string, unknown>

        // If sync didn't complete, poll
        if (prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.status !== 'canceled') {
          prediction = await pollPrediction(cfg.apiToken, String(prediction.id), cfg)
        }

        if (prediction.status === 'failed') {
          return `Prediction failed: ${prediction.error || 'unknown error'}`
        }

        return JSON.stringify(formatPrediction(prediction))
      }

      case 'get': {
        const predictionId = String(normalized.predictionId || normalized.id || '').trim()
        if (!predictionId) return 'Error: "predictionId" is required.'

        const r = await replicateRequest('GET', `/predictions/${predictionId}`, cfg.apiToken)
        if (!r.ok) return `Error: ${r.error}`
        return JSON.stringify(formatPrediction(r.data as Record<string, unknown>))
      }

      case 'cancel': {
        const predictionId = String(normalized.predictionId || normalized.id || '').trim()
        if (!predictionId) return 'Error: "predictionId" is required.'

        const r = await replicateRequest('POST', `/predictions/${predictionId}/cancel`, cfg.apiToken)
        if (!r.ok) return `Error: ${r.error}`
        return `Prediction ${predictionId} canceled.`
      }

      case 'get_model': {
        const model = String(normalized.model || '').trim()
        if (!model) return 'Error: "model" is required (e.g. "stability-ai/sdxl").'

        const r = await replicateRequest('GET', `/models/${model}`, cfg.apiToken)
        if (!r.ok) return `Error: ${r.error}`
        const data = r.data as Record<string, unknown>
        return JSON.stringify({
          owner: data.owner,
          name: data.name,
          description: data.description,
          visibility: data.visibility,
          url: data.url,
          latest_version: data.latest_version ? {
            id: (data.latest_version as Record<string, unknown>).id,
            created_at: (data.latest_version as Record<string, unknown>).created_at,
          } : null,
          run_count: data.run_count,
        })
      }

      case 'search': {
        const query = String(normalized.query || normalized.search || '').trim()
        const cursor = typeof normalized.cursor === 'string' ? normalized.cursor : undefined
        const params = new URLSearchParams()
        if (query) params.set('query', query)
        if (cursor) params.set('cursor', cursor)
        const suffix = params.toString() ? `?${params}` : ''
        const r = await replicateRequest('GET', `/models${suffix}`, cfg.apiToken)
        if (!r.ok) return `Error: ${r.error}`
        const data = r.data as Record<string, unknown>
        const results = (data.results as Record<string, unknown>[]) ?? []
        const items = results.slice(0, 20).map((m) => ({
          owner: m.owner,
          name: m.name,
          description: typeof m.description === 'string' ? m.description.slice(0, 120) : '',
          run_count: m.run_count,
          url: m.url,
        }))
        return JSON.stringify({
          models: items,
          next_cursor: data.next ? (data.next as string).split('cursor=')[1]?.split('&')[0] : null,
        })
      }

      case 'status': {
        return JSON.stringify({
          configured: true,
          hasToken: !!cfg.apiToken,
          defaultModel: cfg.defaultModel || '(none)',
          timeoutMs: cfg.timeoutMs,
        })
      }

      default:
        return `Error: Unknown action "${action}". Use: run, get, cancel, get_model, search, status.`
    }
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

const ReplicatePlugin: Plugin = {
  name: 'Replicate',
  enabledByDefault: false,
  description: 'Run any AI model on Replicate — image generation, LLMs, audio, video, and more. Search models, create predictions, check status.',
  hooks: {
    getCapabilityDescription: () =>
      'I can run any AI model on Replicate using `replicate`. This includes image generation (SDXL, Flux), language models, audio/video processing, and thousands more. I can search for models, run predictions, and check their status.',
  } as PluginHooks,
  tools: [
    {
      name: 'replicate',
      description: 'Run AI models on Replicate. Actions: run (create and wait for prediction), get (check prediction status), cancel (stop a prediction), get_model (model details), search (find models), status (check config).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['run', 'get', 'cancel', 'get_model', 'search', 'status'], description: 'Action to perform' },
          model: { type: 'string', description: 'Model identifier (e.g. "stability-ai/sdxl", "meta/llama-2-70b-chat"). Required for run/get_model.' },
          version: { type: 'string', description: 'Optional specific model version hash for run.' },
          input: { type: 'object', description: 'Model input parameters as key-value pairs (for run). Varies by model.' },
          prompt: { type: 'string', description: 'Shorthand: sets input.prompt for models that accept a prompt (for run).' },
          predictionId: { type: 'string', description: 'Prediction ID (for get/cancel).' },
          query: { type: 'string', description: 'Search query (for search).' },
          cursor: { type: 'string', description: 'Pagination cursor (for search).' },
        },
        required: ['action'],
      },
      execute: async (args) => executeReplicate(args),
    },
  ],
  ui: {
    settingsFields: [
      {
        key: 'apiToken',
        label: 'API Token',
        type: 'secret',
        required: true,
        placeholder: 'r8_...',
        help: 'Your Replicate API token. Find it at replicate.com/account/api-tokens.',
      },
      {
        key: 'defaultModel',
        label: 'Default Model',
        type: 'text',
        placeholder: 'stability-ai/sdxl',
        help: 'Default model to use when none is specified. Format: owner/model-name.',
      },
      {
        key: 'timeoutMs',
        label: 'Timeout (ms)',
        type: 'number',
        defaultValue: 120000,
        help: 'Maximum time to wait for a prediction (default: 120000ms / 2 minutes).',
      },
      {
        key: 'pollingIntervalMs',
        label: 'Polling Interval (ms)',
        type: 'number',
        defaultValue: 2000,
        help: 'How often to poll for prediction results when sync mode times out (default: 2000ms).',
      },
    ],
  },
}

getPluginManager().registerBuiltin('replicate', ReplicatePlugin)

export function buildReplicateTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('replicate')) return []

  return [
    tool(
      async (args) => executeReplicate(args),
      {
        name: 'replicate',
        description: ReplicatePlugin.tools![0].description,
        schema: z.object({
          action: z.enum(['run', 'get', 'cancel', 'get_model', 'search', 'status']).describe('Action to perform'),
          model: z.string().optional().describe('Model identifier (e.g. "stability-ai/sdxl")'),
          version: z.string().optional().describe('Specific model version hash'),
          input: z.record(z.string(), z.unknown()).optional().describe('Model input parameters'),
          prompt: z.string().optional().describe('Shorthand for input.prompt'),
          predictionId: z.string().optional().describe('Prediction ID (for get/cancel)'),
          query: z.string().optional().describe('Search query (for search)'),
          cursor: z.string().optional().describe('Pagination cursor (for search)'),
        }),
      },
    ),
  ]
}
