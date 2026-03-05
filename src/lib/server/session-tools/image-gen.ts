import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { loadSettings } from '../storage'
import { UPLOAD_DIR } from '../storage'
import type { ToolBuildContext } from './context'

type ImageProvider = 'openai' | 'stability' | 'replicate' | 'fal' | 'together' | 'fireworks' | 'bfl' | 'custom'

interface PluginConfig {
  provider: ImageProvider
  apiKey: string
  model: string
  defaultSize: string
  customEndpoint: string
}

function getConfig(): PluginConfig {
  const settings = loadSettings()
  const ps = (settings.pluginSettings as Record<string, Record<string, unknown>> | undefined)?.image_gen ?? {}
  return {
    provider: (ps.provider as ImageProvider) || 'openai',
    apiKey: (ps.apiKey as string) || '',
    model: (ps.model as string) || '',
    defaultSize: (ps.defaultSize as string) || '1024x1024',
    customEndpoint: (ps.customEndpoint as string) || '',
  }
}

type GenResult = { b64?: string; url?: string; error?: string }

// --- Provider Implementations ---

async function generateOpenAI(prompt: string, size: string, quality: string, cfg: PluginConfig): Promise<GenResult> {
  const model = cfg.model || 'gpt-image-1'
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model, prompt, n: 1, size, quality, response_format: 'b64_json' }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) return { error: `OpenAI ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` }
  const data = await res.json()
  return { b64: data?.data?.[0]?.b64_json }
}

async function generateStability(prompt: string, size: string, cfg: PluginConfig): Promise<GenResult> {
  // Stability v2beta uses multipart/form-data and returns raw image bytes
  const model = cfg.model || 'sd3'
  const formData = new FormData()
  formData.append('prompt', prompt)
  formData.append('model', model)
  formData.append('output_format', 'png')
  // Map size to aspect ratio
  const [w, h] = size.split('x').map(Number)
  if (w && h) {
    const ratio = w > h ? '16:9' : h > w ? '9:16' : '1:1'
    formData.append('aspect_ratio', ratio)
  }
  const res = await fetch('https://api.stability.ai/v2beta/stable-image/generate/sd3', {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'image/*' },
    body: formData,
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) return { error: `Stability ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` }
  const buf = Buffer.from(await res.arrayBuffer())
  return { b64: buf.toString('base64') }
}

async function generateReplicate(prompt: string, size: string, cfg: PluginConfig): Promise<GenResult> {
  const model = cfg.model || 'black-forest-labs/flux-schnell'
  const [w, h] = size.split('x').map(Number)
  // Try sync mode first (Prefer: wait blocks up to 60s)
  const createRes = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`, Prefer: 'wait' },
    body: JSON.stringify({ model, input: { prompt, width: w || 1024, height: h || 1024 } }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!createRes.ok) return { error: `Replicate ${createRes.status}: ${(await createRes.text().catch(() => '')).slice(0, 300)}` }
  let prediction = await createRes.json()

  // If sync didn't complete, poll
  if (prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.urls?.get) {
    const deadline = Date.now() + 120_000
    while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))
      const pollRes = await fetch(prediction.urls.get, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      })
      prediction = await pollRes.json()
    }
  }
  if (prediction.status === 'failed') return { error: `Replicate failed: ${prediction.error || 'unknown'}` }
  const output = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output
  if (typeof output === 'string') return { url: output }
  return { error: 'No image in Replicate response.' }
}

async function generateFal(prompt: string, size: string, cfg: PluginConfig): Promise<GenResult> {
  const model = cfg.model || 'fal-ai/flux/schnell'
  const [w, h] = size.split('x').map(Number)
  const res = await fetch(`https://fal.run/${model}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${cfg.apiKey}` },
    body: JSON.stringify({ prompt, image_size: { width: w || 1024, height: h || 1024 }, num_images: 1 }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) return { error: `fal.ai ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` }
  const data = await res.json()
  const imageUrl = data?.images?.[0]?.url
  if (imageUrl) return { url: imageUrl }
  return { error: 'No image in fal.ai response.' }
}

async function generateTogether(prompt: string, size: string, cfg: PluginConfig): Promise<GenResult> {
  const model = cfg.model || 'black-forest-labs/FLUX.1-schnell-Free'
  const [w, h] = size.split('x').map(Number)
  const res = await fetch('https://api.together.xyz/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model, prompt, width: w || 1024, height: h || 1024, n: 1, response_format: 'b64_json' }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) return { error: `Together ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` }
  const data = await res.json()
  const b64 = data?.data?.[0]?.b64_json
  if (b64) return { b64 }
  const url = data?.data?.[0]?.url
  if (url) return { url }
  return { error: 'No image in Together response.' }
}

async function generateFireworks(prompt: string, _size: string, cfg: PluginConfig): Promise<GenResult> {
  const model = cfg.model || 'flux-1-schnell-fp8'
  const res = await fetch(`https://api.fireworks.ai/inference/v1/workflows/accounts/fireworks/models/${model}/text_to_image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}`, Accept: 'image/jpeg' },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) return { error: `Fireworks ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` }
  // Response may be JSON with base64 array or raw image
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) {
    const data = await res.json()
    const b64 = data?.base64?.[0] ?? data?.data?.[0]?.b64_json
    if (b64) return { b64 }
    return { error: 'No image in Fireworks JSON response.' }
  }
  // Raw image bytes
  const buf = Buffer.from(await res.arrayBuffer())
  return { b64: buf.toString('base64') }
}

async function generateBFL(prompt: string, size: string, cfg: PluginConfig): Promise<GenResult> {
  const [w, h] = size.split('x').map(Number)
  const model = cfg.model || 'flux-pro-1.1'
  const createRes = await fetch(`https://api.bfl.ai/v1/${model}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-key': cfg.apiKey },
    body: JSON.stringify({ prompt, width: w || 1024, height: h || 1024 }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!createRes.ok) return { error: `BFL ${createRes.status}: ${(await createRes.text().catch(() => '')).slice(0, 300)}` }
  const task = await createRes.json()
  const pollingUrl = task?.polling_url || (task?.id ? `https://api.bfl.ai/v1/get_result?id=${task.id}` : null)
  if (!pollingUrl) return { error: 'No polling URL from BFL.' }

  // Poll for result
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000))
    const pollRes = await fetch(pollingUrl, {
      headers: { 'x-key': cfg.apiKey },
      signal: AbortSignal.timeout(10_000),
    })
    const result = await pollRes.json()
    if (result.status === 'Ready' && result.result?.sample) return { url: result.result.sample }
    if (result.status === 'Error') return { error: `BFL error: ${result.result || 'unknown'}` }
  }
  return { error: 'BFL generation timed out.' }
}

async function generateCustom(prompt: string, size: string, quality: string, cfg: PluginConfig): Promise<GenResult> {
  if (!cfg.customEndpoint) return { error: 'Custom endpoint URL not configured.' }
  // Assumes OpenAI-compatible image generation API
  const [w, h] = size.split('x').map(Number)
  const res = await fetch(cfg.customEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model || 'default', prompt, n: 1, size, width: w || 1024, height: h || 1024, quality, response_format: 'b64_json' }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) return { error: `Custom API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` }
  const data = await res.json()
  const b64 = data?.data?.[0]?.b64_json ?? data?.images?.[0]?.b64_json ?? data?.b64_json ?? data?.artifacts?.[0]?.base64
  if (b64) return { b64 }
  const url = data?.data?.[0]?.url ?? data?.images?.[0]?.url ?? data?.url
  if (url) return { url }
  return { error: 'No image found in custom API response.' }
}

// --- Dispatcher ---

const PROVIDERS: Record<ImageProvider, (prompt: string, size: string, quality: string, cfg: PluginConfig) => Promise<GenResult>> = {
  openai: generateOpenAI,
  stability: (p, s, _q, c) => generateStability(p, s, c),
  replicate: (p, s, _q, c) => generateReplicate(p, s, c),
  fal: (p, s, _q, c) => generateFal(p, s, c),
  together: (p, s, _q, c) => generateTogether(p, s, c),
  fireworks: (p, s, _q, c) => generateFireworks(p, s, c),
  bfl: (p, s, _q, c) => generateBFL(p, s, c),
  custom: generateCustom,
}

async function saveImageResult(result: GenResult, prompt: string, filename: string | undefined): Promise<string> {
  if (result.error) return `Error: ${result.error}`

  if (result.b64) {
    const buf = Buffer.from(result.b64, 'base64')
    const baseName = filename || `img-${Date.now()}.png`
    const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_')
    const dest = path.join(UPLOAD_DIR, safeName)
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
    fs.writeFileSync(dest, buf)
    return `Image generated (${buf.length} bytes).\n\n![${prompt.slice(0, 60)}](/api/uploads/${safeName})\n\n[Download](/api/uploads/${safeName})`
  }

  if (result.url) {
    // Download remote URL to uploads
    try {
      const res = await fetch(result.url, { signal: AbortSignal.timeout(30_000) })
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        const baseName = filename || `img-${Date.now()}.png`
        const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_')
        const dest = path.join(UPLOAD_DIR, safeName)
        if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
        fs.writeFileSync(dest, buf)
        return `Image generated (${buf.length} bytes).\n\n![${prompt.slice(0, 60)}](/api/uploads/${safeName})\n\n[Download](/api/uploads/${safeName})`
      }
    } catch { /* fall through to URL-only response */ }
    return `Image generated: ${result.url}`
  }

  return 'Error: No image returned.'
}

async function executeImageGen(args: Record<string, unknown>): Promise<string> {
  const normalized = normalizeToolInputArgs(args)
  const prompt = String(normalized.prompt || '').trim()
  if (!prompt) return 'Error: prompt is required.'

  const cfg = getConfig()
  if (!cfg.apiKey) return 'Error: Image generation API key not configured. Ask the user to add one in Plugin Settings > Image Generation.'

  const size = String(normalized.size || cfg.defaultSize)
  const quality = String(normalized.quality || 'standard')
  const filename = normalized.filename as string | undefined

  const generate = PROVIDERS[cfg.provider]
  if (!generate) return `Error: Unknown provider "${cfg.provider}".`

  try {
    const result = await generate(prompt, size, quality, cfg)
    return saveImageResult(result, prompt, filename)
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

const ImageGenPlugin: Plugin = {
  name: 'Image Generation',
  enabledByDefault: false,
  description: 'Generate images from text prompts. Supports OpenAI, Stability AI, Replicate, fal.ai, Together AI, Fireworks AI, BFL (Flux), or any OpenAI-compatible API.',
  hooks: {
    getCapabilityDescription: () =>
      'I can generate images from text descriptions using `generate_image`. Supports different sizes, quality levels, and providers.',
  } as PluginHooks,
  tools: [
    {
      name: 'generate_image',
      description: 'Generate an image from a text prompt. The image is saved and a download link is returned. Use descriptive, detailed prompts for best results.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed text description of the image to generate' },
          size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536', '512x512', '768x768', '1280x720', '720x1280'], description: 'Image dimensions (default: 1024x1024)' },
          quality: { type: 'string', enum: ['standard', 'hd', 'low', 'medium', 'high'], description: 'Quality level (default: standard). Primarily used by OpenAI.' },
          filename: { type: 'string', description: 'Optional filename for the saved image (e.g. "hero-banner.png")' },
        },
        required: ['prompt'],
      },
      execute: async (args) => executeImageGen(args),
    },
  ],
  ui: {
    settingsFields: [
      {
        key: 'provider',
        label: 'Provider',
        type: 'select',
        options: [
          { value: 'openai', label: 'OpenAI (DALL-E / gpt-image)' },
          { value: 'stability', label: 'Stability AI' },
          { value: 'replicate', label: 'Replicate (Flux, SDXL, etc.)' },
          { value: 'fal', label: 'fal.ai (Flux, SDXL, etc.)' },
          { value: 'together', label: 'Together AI' },
          { value: 'fireworks', label: 'Fireworks AI' },
          { value: 'bfl', label: 'BFL / Black Forest Labs (Flux Pro)' },
          { value: 'custom', label: 'Custom (OpenAI-compatible endpoint)' },
        ],
        defaultValue: 'openai',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'secret',
        required: true,
        placeholder: 'sk-... / r8_... / fal-...',
        help: 'API key for the selected provider.',
      },
      {
        key: 'model',
        label: 'Model',
        type: 'text',
        placeholder: 'gpt-image-1 / black-forest-labs/flux-schnell / ...',
        help: 'Model ID. Each provider has its own default if left blank.',
      },
      {
        key: 'defaultSize',
        label: 'Default Size',
        type: 'select',
        options: [
          { value: '1024x1024', label: '1024x1024 (Square)' },
          { value: '1536x1024', label: '1536x1024 (Landscape)' },
          { value: '1024x1536', label: '1024x1536 (Portrait)' },
          { value: '1280x720', label: '1280x720 (16:9)' },
          { value: '512x512', label: '512x512 (Small)' },
          { value: '768x768', label: '768x768 (Medium)' },
        ],
        defaultValue: '1024x1024',
      },
      {
        key: 'customEndpoint',
        label: 'Custom Endpoint URL',
        type: 'text',
        placeholder: 'https://your-api.example.com/v1/images/generations',
        help: 'Only used when provider is "Custom". Should accept OpenAI-compatible image generation requests.',
      },
    ],
  },
}

getPluginManager().registerBuiltin('image_gen', ImageGenPlugin)

export function buildImageGenTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('image_gen')) return []

  return [
    tool(
      async (args) => executeImageGen(args),
      {
        name: 'generate_image',
        description: ImageGenPlugin.tools![0].description,
        schema: z.object({
          prompt: z.string().describe('Detailed text description of the image to generate'),
          size: z.enum(['1024x1024', '1536x1024', '1024x1536', '512x512', '768x768', '1280x720', '720x1280']).optional().describe('Image dimensions (default: 1024x1024)'),
          quality: z.enum(['standard', 'hd', 'low', 'medium', 'high']).optional().describe('Quality level (default: standard)'),
          filename: z.string().optional().describe('Optional filename for the saved image'),
        }),
      },
    ),
  ]
}
