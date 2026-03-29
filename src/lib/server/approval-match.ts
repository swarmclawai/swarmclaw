import type { ApprovalCategory, ApprovalRequest } from '@/types'

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeScalar(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return ''
    if (/^0x[0-9a-f]+$/i.test(trimmed)) return trimmed.toLowerCase()
    return trimmed
  }
  return value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue)
  if (!isPlainRecord(value)) return normalizeScalar(value)
  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const normalized = canonicalizeValue(value[key])
      if (normalized !== undefined) acc[key] = normalized
      return acc
    }, {})
}

export function buildApprovalComparablePayload(
  category: ApprovalCategory,
  data: Record<string, unknown>,
): Record<string, unknown> | null {
  switch (category) {
    case 'tool_access': {
      const targetId = trimString(data.toolId) || trimString(data.extensionId)
      return targetId ? { targetId } : null
    }
    case 'extension_scaffold':
      return {
        filename: trimString(data.filename),
        code: trimString(data.code),
      }
    case 'extension_install':
      return {
        url: trimString(data.url),
        extensionId: trimString(data.extensionId),
        filename: trimString(data.filename),
      }
    case 'human_loop':
      return {
        question: trimString(data.question),
        prompt: trimString(data.prompt),
        correlationId: trimString(data.correlationId),
      }
    case 'connector_sender':
      return {
        connectorId: trimString(data.connectorId),
        senderId: trimString(data.senderId),
        channelId: trimString(data.channelId),
      }
    case 'task_tool':
      return {
        toolName: trimString(data.toolName),
        args: canonicalizeValue(data.args),
      }
    default:
      return canonicalizeValue(data) as Record<string, unknown>
  }
}

export function buildApprovalMatchKey(input: {
  category: ApprovalCategory
  agentId?: string | null
  sessionId?: string | null
  taskId?: string | null
  data: Record<string, unknown>
}): string | null {
  const comparable = buildApprovalComparablePayload(input.category, input.data)
  if (!comparable) return null
  const scope = (() => {
    switch (input.category) {
      case 'tool_access':
      case 'connector_sender':
        return {
          agentId: trimString(input.agentId) || null,
          sessionId: trimString(input.agentId) ? null : (trimString(input.sessionId) || null),
          taskId: null,
        }
      default:
        return {
          agentId: trimString(input.agentId) || null,
          sessionId: trimString(input.sessionId) || null,
          taskId: trimString(input.taskId) || null,
        }
    }
  })()
  return JSON.stringify({
    category: input.category,
    ...scope,
    data: comparable,
  })
}

export function buildApprovalMatchKeyFromRequest(request: ApprovalRequest): string | null {
  return buildApprovalMatchKey({
    category: request.category,
    agentId: request.agentId,
    sessionId: request.sessionId,
    taskId: request.taskId,
    data: request.data,
  })
}
