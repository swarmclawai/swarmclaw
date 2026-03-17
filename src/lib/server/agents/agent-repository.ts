import type { Agent } from '@/types'

import {
  deleteAgent as deleteStoredAgent,
  loadAgent as loadStoredAgent,
  loadAgents as loadStoredAgents,
  loadTrashedAgents as loadStoredTrashedAgents,
  patchAgent as patchStoredAgent,
  saveAgents as saveStoredAgents,
  upsertAgent as upsertStoredAgent,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

type AgentRepositoryOptions = { includeTrashed?: boolean }

export const agentRepository = createRecordRepository<Agent, AgentRepositoryOptions>(
  'agents',
  {
    get(id, options) {
      return loadStoredAgent(id, options) as Agent | null
    },
    list(options) {
      return loadStoredAgents(options) as Record<string, Agent>
    },
    upsert(id, value) {
      upsertStoredAgent(id, value)
    },
    replace(data) {
      saveStoredAgents(data)
    },
    patch(id, updater) {
      return patchStoredAgent(id, updater as (current: Agent | null) => Agent | null) as Agent | null
    },
    delete(id) {
      deleteStoredAgent(id)
    },
  },
)

export function getAgent(id: string, options?: AgentRepositoryOptions): Agent | null {
  return agentRepository.get(id, options)
}

export function getAgents(ids: string[], options?: AgentRepositoryOptions): Record<string, Agent> {
  return agentRepository.getMany(ids, options)
}

export function listAgents(options?: AgentRepositoryOptions): Record<string, Agent> {
  return agentRepository.list(options)
}

export function saveAgent(id: string, agent: Agent | Record<string, unknown>): void {
  agentRepository.upsert(id, agent as Agent)
}

export function saveAgentMany(entries: Array<[string, Agent | Record<string, unknown>]>): void {
  agentRepository.upsertMany(entries as Array<[string, Agent]>)
}

export function replaceAgents(agents: Record<string, Agent | Record<string, unknown>>): void {
  agentRepository.replace(agents as Record<string, Agent>)
}

export function patchAgent(id: string, updater: (current: Agent | null) => Agent | null): Agent | null {
  return agentRepository.patch(id, updater)
}

export function deleteAgent(id: string): void {
  agentRepository.delete(id)
}

export function loadAgents(options?: AgentRepositoryOptions): Record<string, Agent> {
  return listAgents(options)
}

export function loadAgent(id: string, options?: AgentRepositoryOptions): Agent | null {
  return getAgent(id, options)
}

export function saveAgents(agents: Record<string, Agent | Record<string, unknown>>): void {
  replaceAgents(agents)
}

export function upsertAgent(id: string, agent: Agent | Record<string, unknown>): void {
  saveAgent(id, agent)
}

export function loadTrashedAgents(): Record<string, Agent> {
  return loadStoredTrashedAgents() as Record<string, Agent>
}
