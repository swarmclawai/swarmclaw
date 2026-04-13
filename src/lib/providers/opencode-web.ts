import type { StreamChatOptions } from './index'
import { log } from '../server/logger'

const TAG = 'opencode-web'

const DEFAULT_ENDPOINT = 'http://localhost:4096'
const DEFAULT_USERNAME = 'opencode'

interface BasicAuth { username: string; password: string }

/**
 * Parse an apiKey field into HTTP Basic Auth components. Stored as a single
 * encrypted string per the project-wide credential model.
 *
 * - null / empty → no auth header.
 * - "user:pass"   → { username: 'user', password: 'pass' }
 * - "pass"        → { username: 'opencode', password: 'pass' } (FR-10).
 *
 * Mirrors RFC 3986 userinfo and `curl -u` conventions so the format is
 * unsurprising and self-documenting in the credential field placeholder.
 */
export function parseBasicAuth(apiKey: string | null | undefined): BasicAuth | null {
  if (apiKey === null || apiKey === undefined) return null
  const trimmed = apiKey.trim()
  if (!trimmed) return null
  const colon = trimmed.indexOf(':')
  if (colon < 0) return { username: DEFAULT_USERNAME, password: trimmed }
  return { username: trimmed.slice(0, colon), password: trimmed.slice(colon + 1) }
}

export function buildAuthHeader(auth: BasicAuth | null): string | undefined {
  if (!auth) return undefined
  const encoded = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')
  return `Basic ${encoded}`
}

/**
 * Split a SwarmClaw model string into the `{ providerID, modelID }` shape
 * OpenCode expects. The convention is a single forward slash:
 *   "anthropic/claude-sonnet-4-5" → { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' }
 *
 * If the user enters a bare string with no slash, send providerID=value and
 * an empty modelID so OpenCode rejects with a real error rather than us
 * guessing wrong. Whitespace is trimmed.
 */
export function parseModelId(model: string | null | undefined): { providerID: string; modelID: string } {
  const trimmed = (model || '').trim()
  if (!trimmed) return { providerID: '', modelID: '' }
  const slash = trimmed.indexOf('/')
  if (slash < 0) return { providerID: trimmed, modelID: '' }
  return {
    providerID: trimmed.slice(0, slash).trim(),
    modelID: trimmed.slice(slash + 1).trim(),
  }
}

export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

/**
 * Stateful SSE line parser. Buffers across chunk boundaries and emits
 * one parsed JSON object per `data:` line. Lines that do not start with
 * `data:` (comments, `event:`, `id:`, blank separators) are ignored.
 */
export class SseLineParser {
  private buf = ''

  feed(chunk: string, onEvent: (data: unknown) => void): void {
    this.buf += chunk
    const lines = this.buf.split('\n')
    this.buf = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '').trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      try {
        onEvent(JSON.parse(payload))
      } catch {
        // Non-JSON SSE payload (heartbeat, keep-alive). Ignore.
      }
    }
  }
}

/**
 * Best-effort extraction of streamed text out of an OpenCode SSE event.
 * The shape varies a bit between versions; we accept the common variants
 * and return null for everything else.
 */
function extractTextDelta(ev: unknown): string | null {
  if (!ev || typeof ev !== 'object') return null
  const e = ev as Record<string, unknown>
  if (typeof e.text === 'string' && (e.type === 'text-delta' || e.type === 'text' || e.type === 'message.update.delta')) {
    return e.text
  }
  if (e.type === 'message.update.delta' && typeof (e.delta as Record<string, unknown>)?.text === 'string') {
    return (e.delta as Record<string, unknown>).text as string
  }
  if (e.type === 'text' && typeof (e.part as Record<string, unknown>)?.text === 'string') {
    return (e.part as Record<string, unknown>).text as string
  }
  return null
}

function isCompletionEvent(ev: unknown): boolean {
  if (!ev || typeof ev !== 'object') return false
  const t = (ev as Record<string, unknown>).type
  return t === 'message.complete' || t === 'message.completed' || t === 'done' || t === 'response.completed'
}

function extractErrorMessage(ev: unknown): string | null {
  if (!ev || typeof ev !== 'object') return null
  const e = ev as Record<string, unknown>
  if (e.type !== 'error') return null
  if (typeof e.message === 'string') return e.message
  if (typeof e.error === 'string') return e.error
  return 'Unknown OpenCode event error'
}

interface CreateSessionResponse { id?: string; sessionID?: string; sessionId?: string }

async function createSession(opts: {
  endpoint: string
  cwd: string
  authHeader: string | undefined
  signal: AbortSignal
}): Promise<string> {
  const url = `${joinUrl(opts.endpoint, '/session')}?directory=${encodeURIComponent(opts.cwd)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.authHeader ? { Authorization: opts.authHeader } : {}),
    },
    body: '{}',
    signal: opts.signal,
  })
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(res.status, 'OpenCode rejected the credentials. Check the username:password configured for this agent.')
  }
  if (!res.ok) {
    const body = await safeReadText(res)
    throw new HttpError(res.status, `OpenCode session create failed (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`)
  }
  const json = (await res.json()) as CreateSessionResponse
  const id = json.id || json.sessionID || json.sessionId
  if (!id || typeof id !== 'string') {
    throw new HttpError(0, 'OpenCode session create response did not include an id')
  }
  return id
}

async function postPrompt(opts: {
  endpoint: string
  sessionId: string
  cwd: string
  prompt: string
  providerID: string
  modelID: string
  authHeader: string | undefined
  signal: AbortSignal
}): Promise<{ status: number }> {
  const url = `${joinUrl(opts.endpoint, `/session/${encodeURIComponent(opts.sessionId)}/prompt_async`)}?directory=${encodeURIComponent(opts.cwd)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.authHeader ? { Authorization: opts.authHeader } : {}),
    },
    body: JSON.stringify({
      providerID: opts.providerID,
      modelID: opts.modelID,
      prompt: opts.prompt,
    }),
    signal: opts.signal,
  })
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(res.status, 'OpenCode rejected the credentials. Check the username:password configured for this agent.')
  }
  if (res.status !== 204 && res.status !== 200 && res.status !== 202) {
    if (res.status === 404) return { status: 404 }
    const body = await safeReadText(res)
    throw new HttpError(res.status, `OpenCode prompt_async failed (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`)
  }
  return { status: res.status }
}

async function safeReadText(res: Response): Promise<string> {
  try { return await res.text() } catch { return '' }
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

/**
 * Stream an agent chat turn against a remote OpenCode HTTP server
 * (`opencode serve` or `opencode web`). Talks to the same REST + SSE API
 * as the official CLI. Stores the OpenCode session id on
 * `session.opencodeWebSessionId` so subsequent turns reuse it.
 */
export function streamOpenCodeWebChat(opts: StreamChatOptions): Promise<string> {
  const { session, message, systemPrompt, apiKey, write, active, signal } = opts

  const endpoint = (session.apiEndpoint as string | undefined) || DEFAULT_ENDPOINT
  const cwd = (session.cwd as string | undefined) || process.cwd()
  const auth = parseBasicAuth(apiKey)
  const authHeader = buildAuthHeader(auth)
  const { providerID, modelID } = parseModelId(session.model as string | undefined)

  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  active.set(session.id, controller)

  const promptParts: string[] = []
  if (systemPrompt && !session.opencodeWebSessionId) {
    promptParts.push(`[System instructions]\n${systemPrompt}`)
  }
  promptParts.push(message)
  const prompt = promptParts.join('\n\n')

  return (async () => {
    let fullResponse = ''
    try {
      // Ensure we have a server-side session id. On HTTP 404 from prompt
      // (FR-9: graceful expiry), we null this and recreate exactly once.
      let sessionId = (session.opencodeWebSessionId as string | null | undefined)
        || await createSession({ endpoint, cwd, authHeader, signal: controller.signal })
      session.opencodeWebSessionId = sessionId

      let postResult = await postPrompt({
        endpoint, sessionId, cwd, prompt, providerID, modelID, authHeader, signal: controller.signal,
      })
      if (postResult.status === 404) {
        log.info(TAG, `[${session.id}] session ${sessionId} returned 404, recreating`)
        sessionId = await createSession({ endpoint, cwd, authHeader, signal: controller.signal })
        session.opencodeWebSessionId = sessionId
        postResult = await postPrompt({
          endpoint, sessionId, cwd, prompt, providerID, modelID, authHeader, signal: controller.signal,
        })
        if (postResult.status === 404) {
          throw new HttpError(404, 'OpenCode rejected the prompt for a freshly-created session — the server may be misconfigured.')
        }
      }

      const eventUrl = `${joinUrl(endpoint, '/event')}?session=${encodeURIComponent(sessionId)}`
      const eventRes = await fetch(eventUrl, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        signal: controller.signal,
      })
      if (!eventRes.ok || !eventRes.body) {
        throw new HttpError(eventRes.status, `OpenCode event stream failed (HTTP ${eventRes.status})`)
      }

      const reader = eventRes.body.getReader()
      const decoder = new TextDecoder()
      const parser = new SseLineParser()
      let completed = false

      while (!completed) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        parser.feed(chunk, (ev) => {
          const text = extractTextDelta(ev)
          if (text) {
            fullResponse += text
            write(`data: ${JSON.stringify({ t: 'd', text })}\n\n`)
            return
          }
          const errMsg = extractErrorMessage(ev)
          if (errMsg) {
            write(`data: ${JSON.stringify({ t: 'err', text: errMsg })}\n\n`)
            return
          }
          if (isCompletionEvent(ev)) completed = true
        })
      }

      return fullResponse
    } catch (err: unknown) {
      const msg = err instanceof HttpError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err)
      log.error(TAG, `[${session.id}] ${msg}`)
      write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
      return fullResponse
    } finally {
      active.delete(session.id)
    }
  })()
}
