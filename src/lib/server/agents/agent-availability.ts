import type { Agent } from '@/types'
import { WORKER_ONLY_PROVIDER_IDS } from '@/lib/provider-sets'

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

export function isWorkerOnlyAgent(agent: Pick<Agent, 'provider'> | null | undefined): boolean {
  return typeof agent?.provider === 'string' && WORKER_ONLY_PROVIDER_IDS.has(agent.provider)
}

export function buildWorkerOnlyAgentMessage(
  agent: Pick<Agent, 'name'> | null | undefined,
  action?: string,
): string {
  const name = typeof agent?.name === 'string' && agent.name.trim()
    ? agent.name.trim()
    : 'This agent'
  if (action) return `${name} uses a worker-only provider and cannot ${action}. Worker-only agents can only be used for direct chats and delegation.`
  return `${name} uses a worker-only provider and cannot join chatrooms. Worker-only agents can only be used for direct chats and delegation.`
}
