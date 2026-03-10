import type { Agent } from '@/types'

function normalizeReference(reference: string): string {
  return reference
    .trim()
    .replace(/^@/, '')
    .replace(/^agent\s+/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.,!?;:]+$/g, '')
    .trim()
    .toLowerCase()
}

export function resolveAgentReference(
  reference: string,
  agents: Record<string, Agent>,
): string | null {
  const normalized = normalizeReference(reference)
  if (!normalized) return null

  const agentList = Object.values(agents)
  const exactId = agentList.find((agent) => agent.id.toLowerCase() === normalized)
  if (exactId) return exactId.id

  const exactName = agentList.find((agent) => agent.name.toLowerCase() === normalized)
  if (exactName) return exactName.id

  const startsWithId = agentList.find((agent) => agent.id.toLowerCase().startsWith(normalized))
  if (startsWithId) return startsWithId.id

  const startsWithName = agentList.find((agent) => agent.name.toLowerCase().startsWith(normalized))
  if (startsWithName) return startsWithName.id

  return null
}

/**
 * Parse @AgentName mentions from text and resolve to an agent ID.
 * Uses case-insensitive exact match, then falls back to starts-with.
 */
export function parseMentionedAgentId(
  description: string,
  agents: Record<string, Agent>,
): string | null {
  const mentionRegex = /(?:^|[\s(])@([a-zA-Z0-9._-]+)/g
  let match: RegExpExecArray | null

  while ((match = mentionRegex.exec(description)) !== null) {
    const mention = match[1] || ''
    const resolved = resolveAgentReference(mention, agents)
    if (resolved) return resolved
  }

  return null
}

export function parseAssignedAgentId(
  description: string,
  agents: Record<string, Agent>,
): string | null {
  const patterns = [
    /(?:assign(?:ed)?|delegate(?:d)?|route(?:d)?|hand(?:ed)?)(?:\s+\w+){0,4}\s+to\s+(?:agent\s+)?["'`]?([^"'`\n]+?)["'`]?(?=$|[\s.,;:])/gi,
    /(?:assignee|assigned[_\s-]?to|agent(?:\s+id)?)\s*[:=]\s*["'`]?([^"'`\n]+?)["'`]?(?=$|[\s.,;:])/gi,
    /for\s+agent\s+["'`]?([^"'`\n]+?)["'`]?(?=$|[\s.,;:])/gi,
  ]

  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(description)) !== null) {
      const candidate = (match[1] || '').trim()
      const resolved = resolveAgentReference(candidate, agents)
      if (resolved) return resolved
    }
  }

  return null
}

/**
 * Resolve task agent: if description has an @mention, use that agent.
 * Otherwise fall back to an explicit assignment phrase, then currentAgentId.
 */
export function resolveTaskAgentFromDescription(
  description: string,
  currentAgentId: string,
  agents: Record<string, Agent>,
): string {
  const mentioned = parseMentionedAgentId(description, agents)
  if (mentioned) return mentioned
  const assigned = parseAssignedAgentId(description, agents)
  return assigned || currentAgentId
}
