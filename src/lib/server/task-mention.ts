import type { Agent } from '@/types'

/**
 * Parse @AgentName mentions from text and resolve to an agent ID.
 * Uses case-insensitive exact match, then falls back to starts-with.
 */
export function parseMentionedAgentId(
  description: string,
  agents: Record<string, Agent>,
): string | null {
  const mentionRegex = /@(\S+)/g
  const agentList = Object.values(agents)
  let match: RegExpExecArray | null

  while ((match = mentionRegex.exec(description)) !== null) {
    const mention = match[1].toLowerCase()

    // Exact name match (case-insensitive)
    const exact = agentList.find((a) => a.name.toLowerCase() === mention)
    if (exact) return exact.id

    // Starts-with match (for partial names like @code matching "CodeBot")
    const startsWith = agentList.find((a) => a.name.toLowerCase().startsWith(mention))
    if (startsWith) return startsWith.id
  }

  return null
}

/**
 * Resolve task agent: if description has an @mention, use that agent.
 * Otherwise fall back to currentAgentId.
 */
export function resolveTaskAgentFromDescription(
  description: string,
  currentAgentId: string,
  agents: Record<string, Agent>,
): string {
  const mentioned = parseMentionedAgentId(description, agents)
  return mentioned || currentAgentId
}
