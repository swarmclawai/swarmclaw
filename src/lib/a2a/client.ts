import { genId } from '@/lib/id'
import { log } from '@/lib/server/logger'
import { errorMessage } from '@/lib/shared-utils'
import { resolveCredentialSecret } from '@/lib/server/credentials/credential-service'
import { buildA2AAuthHeaders } from './auth'
import type { JsonRpcRequest, JsonRpcResponse, A2AClientOptions } from './types'

const TAG = 'a2a-client'

/**
 * Call a remote A2A agent via JSON-RPC 2.0.
 */
export async function callA2AAgent<T = unknown>(
  agentUrl: string,
  method: string,
  params: Record<string, unknown>,
  options: A2AClientOptions = {},
): Promise<T> {
  const { timeout = 30_000, credentialId, retryAttempts = 3 } = options

  const accessKey = credentialId ? resolveCredentialSecret(credentialId) : null
  const headers = accessKey ? buildA2AAuthHeaders(accessKey) : { 'Content-Type': 'application/json' }

  const rpcRequest: JsonRpcRequest = {
    jsonrpc: '2.0',
    method,
    params,
    id: genId(8),
  }

  let lastError: Error | null = null

  for (let attempt = 0; attempt < retryAttempts; attempt++) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(agentUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(rpcRequest),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      const data = (await response.json()) as JsonRpcResponse<T>

      if (data.error) {
        throw new Error(`A2A RPC error (${data.error.code}): ${data.error.message}`)
      }

      return data.result as T
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(errorMessage(err))

      if (lastError.name === 'AbortError') {
        throw new Error(`A2A request to ${agentUrl} timed out after ${timeout}ms`)
      }

      if (attempt < retryAttempts - 1) {
        const backoff = Math.pow(2, attempt) * 1000
        log.warn(TAG, `Attempt ${attempt + 1} failed for ${agentUrl}, retrying in ${backoff}ms: ${errorMessage(err)}`)
        await new Promise(resolve => setTimeout(resolve, backoff))
      }
    }
  }

  throw lastError ?? new Error(`A2A request to ${agentUrl} failed after ${retryAttempts} attempts`)
}

/**
 * Stream A2A responses using Server-Sent Events.
 */
export async function* streamA2AResponse(
  agentUrl: string,
  method: string,
  params: Record<string, unknown>,
  options: A2AClientOptions = {},
): AsyncGenerator<unknown> {
  const { credentialId } = options
  const accessKey = credentialId ? resolveCredentialSecret(credentialId) : null
  const headers: Record<string, string> = {
    ...(accessKey ? buildA2AAuthHeaders(accessKey) : { 'Content-Type': 'application/json' }),
    'Accept': 'text/event-stream',
  }

  const rpcRequest: JsonRpcRequest = {
    jsonrpc: '2.0',
    method,
    params,
    id: genId(8),
  }

  const response = await fetch(agentUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(rpcRequest),
  })

  if (!response.ok) {
    throw new Error(`A2A streaming request failed: ${response.status} ${response.statusText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body for A2A stream')

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            yield JSON.parse(line.slice(6)) as unknown
          } catch {
            log.warn(TAG, `Failed to parse SSE data: ${line.slice(0, 200)}`)
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
