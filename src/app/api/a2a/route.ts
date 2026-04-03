import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { validateA2ARequest, extractA2AHeaders } from '@/lib/a2a/auth'
import { JsonRpcRequestSchema, JSON_RPC_ERRORS } from '@/lib/a2a/types'
import type { A2AContext } from '@/lib/a2a/types'
import { a2aRouter } from '@/lib/a2a/json-rpc-router'
import { log } from '@/lib/server/logger'

// Ensure handlers are registered
import '@/lib/a2a/handlers'

export const dynamic = 'force-dynamic'

/**
 * POST /api/a2a
 *
 * Main A2A JSON-RPC 2.0 endpoint.
 * Accepts JSON-RPC requests and routes them to registered handlers.
 */
export async function POST(req: Request) {
  // Authenticate
  const auth = validateA2ARequest(req)
  if (!auth.valid) {
    return NextResponse.json({
      jsonrpc: '2.0',
      error: { code: JSON_RPC_ERRORS.AUTH_FAILED, message: auth.error ?? 'Authentication failed' },
    }, { status: 401 })
  }

  // Parse body
  const { data: body, error: parseError } = await safeParseBody(req)
  if (parseError) return parseError

  // Validate JSON-RPC envelope
  const validation = JsonRpcRequestSchema.safeParse(body)
  if (!validation.success) {
    return NextResponse.json({
      jsonrpc: '2.0',
      error: { code: JSON_RPC_ERRORS.PARSE_ERROR, message: 'Invalid JSON-RPC request', data: validation.error.issues },
    }, { status: 400 })
  }

  const rpcRequest = validation.data
  const headers = extractA2AHeaders(req)

  const context: A2AContext = {
    agentId: headers.targetAgentId ?? '',
    requesterId: headers.requesterAgentId ?? auth.agentId ?? 'unknown',
    timestamp: new Date(),
  }

  log.info('a2a', `JSON-RPC ${rpcRequest.method}`, { agentId: context.agentId, requesterId: context.requesterId })

  const response = await a2aRouter.route(rpcRequest, context)
  return NextResponse.json(response)
}
