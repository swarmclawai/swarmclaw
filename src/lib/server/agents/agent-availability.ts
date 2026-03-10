import type { Agent } from '@/types'

export function isAgentDisabled(agent: Pick<Agent, 'disabled'> | null | undefined): boolean {
  return agent?.disabled === true
}

export function buildAgentDisabledMessage(
  agent: Pick<Agent, 'name'> | null | undefined,
  action?: string,
): string {
  const name = typeof agent?.name === 'string' && agent.name.trim()
    ? agent.name.trim()
    : 'This agent'
  if (action) return `${name} is disabled and cannot ${action}. Re-enable it to continue.`
  return `${name} is disabled. Re-enable it to continue.`
}
