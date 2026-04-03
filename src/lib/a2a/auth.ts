import { validateAccessKey } from '@/lib/server/storage-auth'

export interface A2AAuthResult {
  valid: boolean
  agentId: string | null
  error?: string
}

/**
 * Validate an inbound A2A request using the SwarmClaw access key.
 * Checks `Authorization: Bearer <key>` or `x-a2a-access-key` header.
 */
export function validateA2ARequest(req: Request): A2AAuthResult {
  const authHeader = req.headers.get('authorization')
  const a2aKeyHeader = req.headers.get('x-a2a-access-key')

  let key: string | null = null
  if (authHeader?.startsWith('Bearer ')) {
    key = authHeader.slice(7)
  } else if (a2aKeyHeader) {
    key = a2aKeyHeader
  }

  if (!key) {
    return { valid: false, agentId: null, error: 'Missing authentication — provide Authorization: Bearer <key> or x-a2a-access-key header' }
  }

  if (!validateAccessKey(key)) {
    return { valid: false, agentId: null, error: 'Invalid access key' }
  }

  const agentId = req.headers.get('x-a2a-agent-id')
  return { valid: true, agentId }
}

/**
 * Extract A2A-specific headers from an inbound request.
 */
export function extractA2AHeaders(req: Request): { targetAgentId: string | null; requesterAgentId: string | null } {
  return {
    targetAgentId: req.headers.get('x-a2a-target-agent-id'),
    requesterAgentId: req.headers.get('x-a2a-agent-id'),
  }
}

/**
 * Build auth headers for outbound A2A requests to remote agents.
 */
export function buildA2AAuthHeaders(accessKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessKey}`,
  }
}
