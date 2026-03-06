import type { Agent } from '@/types'
import { resolveAgentReference, resolveTaskAgentFromDescription } from './task-mention'

export const MANAGED_AGENT_REFERENCE_KEYS = [
  'agentId',
  'agent_id',
  'assignedAgentId',
  'assigned_agent_id',
  'assignedToAgentId',
  'assigned_to_agent_id',
  'assigneeId',
  'assignee_id',
  'assignedAgent',
  'assigned_agent',
  'assignedTo',
  'assigned_to',
  'assignee',
  'agent',
  'owner',
] as const

type AssignmentSource = 'explicit' | 'description' | 'fallback' | 'none'

export interface ManagedAgentAssignmentResolution {
  agentId: string | null
  explicitReference: string | null
  unresolvedReference: string | null
  source: AssignmentSource
  hadExplicitInput: boolean
}

function firstNonEmptyString(
  parsed: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const raw = parsed[key]
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed) return trimmed
  }
  return null
}

export function hasManagedAgentAssignmentInput(
  parsed: Record<string, unknown>,
  keys: readonly string[] = MANAGED_AGENT_REFERENCE_KEYS,
): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(parsed, key))
}

export function resolveManagedAgentAssignment(
  parsed: Record<string, unknown>,
  agents: Record<string, Agent>,
  fallbackAgentId?: string | null,
  opts?: {
    allowDescription?: boolean
    keys?: readonly string[]
  },
): ManagedAgentAssignmentResolution {
  const keys = opts?.keys ?? MANAGED_AGENT_REFERENCE_KEYS
  const explicitReference = firstNonEmptyString(parsed, keys)
  const hadExplicitInput = hasManagedAgentAssignmentInput(parsed, keys)
  if (explicitReference) {
    const resolved = resolveAgentReference(explicitReference, agents)
    return {
      agentId: resolved,
      explicitReference,
      unresolvedReference: resolved ? null : explicitReference,
      source: 'explicit',
      hadExplicitInput,
    }
  }

  if (opts?.allowDescription !== false) {
    const description = typeof parsed.description === 'string' ? parsed.description.trim() : ''
    if (description) {
      const resolvedFromDescription = resolveTaskAgentFromDescription(description, '', agents).trim()
      if (resolvedFromDescription) {
        return {
          agentId: resolvedFromDescription,
          explicitReference: null,
          unresolvedReference: null,
          source: 'description',
          hadExplicitInput,
        }
      }
    }
  }

  const fallback = typeof fallbackAgentId === 'string' ? fallbackAgentId.trim() : ''
  if (fallback) {
    return {
      agentId: fallback,
      explicitReference: null,
      unresolvedReference: null,
      source: 'fallback',
      hadExplicitInput,
    }
  }

  return {
    agentId: null,
    explicitReference: null,
    unresolvedReference: null,
    source: 'none',
    hadExplicitInput,
  }
}

export function resolveDelegatorAgentId(
  parsed: Record<string, unknown>,
  agents: Record<string, Agent>,
  fallbackAgentId?: string | null,
): string | null {
  const explicitDelegator = typeof parsed.delegatedByAgentId === 'string'
    ? parsed.delegatedByAgentId.trim()
    : ''
  if (explicitDelegator) {
    return resolveAgentReference(explicitDelegator, agents) || explicitDelegator
  }
  const fallback = typeof fallbackAgentId === 'string' ? fallbackAgentId.trim() : ''
  return fallback || null
}

export function isDelegationTaskPayload(parsed: Record<string, unknown>): boolean {
  const sourceType = typeof parsed.sourceType === 'string' ? parsed.sourceType.trim().toLowerCase() : ''
  if (sourceType === 'delegation') return true
  if (typeof parsed.delegatedFromTaskId === 'string' && parsed.delegatedFromTaskId.trim()) return true
  if (typeof parsed.delegatedByAgentId === 'string' && parsed.delegatedByAgentId.trim()) return true
  return false
}

export function validateManagedAgentAssignment(params: {
  resourceLabel: string
  agents: Record<string, Agent>
  assignScope: 'self' | 'all'
  currentAgentId?: string | null
  targetAgentId?: string | null
  unresolvedReference?: string | null
  isDelegation?: boolean
  delegatorAgentId?: string | null
}): string | null {
  const currentAgentId = typeof params.currentAgentId === 'string' ? params.currentAgentId.trim() : ''
  const targetAgentId = typeof params.targetAgentId === 'string' ? params.targetAgentId.trim() : ''
  const unresolvedReference = typeof params.unresolvedReference === 'string' ? params.unresolvedReference.trim() : ''
  const delegatorAgentId = typeof params.delegatorAgentId === 'string' ? params.delegatorAgentId.trim() : ''

  if (unresolvedReference) {
    return `Error: Unknown agent "${unresolvedReference}". Use an existing agent ID or exact agent name.`
  }

  if (targetAgentId && !params.agents[targetAgentId]) {
    return `Error: Unknown agent "${targetAgentId}". Use an existing agent ID or exact agent name.`
  }

  if (params.assignScope === 'self' && currentAgentId && targetAgentId && targetAgentId !== currentAgentId) {
    return `Error: You can only assign ${params.resourceLabel} to yourself ("${currentAgentId}"). To assign to other agents, ask a user to enable "Assign to Other Agents" in your agent settings.`
  }

  if (params.isDelegation && targetAgentId) {
    const comparisonId = delegatorAgentId || currentAgentId
    if (comparisonId && targetAgentId === comparisonId) {
      return 'Error: Delegation target must be a different agent ID. Create a normal self-task instead of delegating to yourself.'
    }
  }

  return null
}
