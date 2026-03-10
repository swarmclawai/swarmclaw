import type { ChatroomRoutingRule, Agent } from '@/types'

/**
 * Evaluate routing rules against inbound message text.
 *
 * Rules are evaluated in priority order (lower number = higher priority).
 * First match wins — returns the matched agentIds.
 *
 * - 'keyword' rules: case-insensitive substring match against `keywords[]`,
 *   or regex match against `pattern`.
 * - 'capability' rules: match `pattern` against each agent's `capabilities[]`.
 */
export function evaluateRoutingRules(
  text: string,
  rules: ChatroomRoutingRule[],
  agents: Agent[],
): string[] {
  if (!rules.length) return []

  const sorted = [...rules].sort((a, b) => a.priority - b.priority)
  const lowerText = text.toLowerCase()

  for (const rule of sorted) {
    if (rule.type === 'keyword') {
      let matched = false

      // Check keywords (case-insensitive substring)
      if (rule.keywords?.length) {
        matched = rule.keywords.some((kw) => lowerText.includes(kw.toLowerCase()))
      }

      // Check pattern (regex)
      if (!matched && rule.pattern) {
        try {
          const re = new RegExp(rule.pattern, 'i')
          matched = re.test(text)
        } catch {
          // Invalid regex — skip
        }
      }

      if (matched) return [rule.agentId]
    }

    if (rule.type === 'capability') {
      if (!rule.pattern) continue
      const patternLower = rule.pattern.toLowerCase()

      // Check if the specific agent has a matching capability
      const agent = agents.find((a) => a.id === rule.agentId)
      if (agent?.capabilities?.some((cap) => cap.toLowerCase().includes(patternLower))) {
        // Only match if the message text is relevant to the capability
        // Use the pattern as a keyword match against the message text too
        try {
          const re = new RegExp(rule.pattern, 'i')
          if (re.test(text)) return [rule.agentId]
        } catch {
          if (lowerText.includes(patternLower)) return [rule.agentId]
        }
      }
    }
  }

  return []
}
