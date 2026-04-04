import { genId } from '@/lib/id'
import { resolveAgentToolSelection } from '@/lib/agent-default-tools'
import { normalizeAgentExecuteConfig } from '@/lib/agent-execute-defaults'
import { normalizeAgentSandboxConfig } from '@/lib/agent-sandbox-defaults'
import { normalizeCapabilitySelection } from '@/lib/capability-selection'
import { normalizeProviderEndpoint } from '@/lib/openclaw/openclaw-endpoint'
import { normalizeOrchestratorConfig } from '@/lib/orchestrator-config'
import { buildAgentDisabledMessage, isAgentDisabled } from '@/lib/server/agents/agent-availability'
import { suspendAgentReferences, purgeAgentReferences, restoreAgentSchedules } from '@/lib/server/agents/agent-cascade'
import { ensureAgentThreadSession } from '@/lib/server/agents/agent-thread-session'
import {
  deleteAgent,
  loadAgents,
  loadTrashedAgents,
  patchAgent,
  saveAgent,
} from '@/lib/server/agents/agent-repository'
import { logActivity } from '@/lib/server/activity/activity-log'
import { getAgentSpendWindows } from '@/lib/server/cost'
import { serviceFail, serviceOk } from '@/lib/server/service-result'
import { listSessions, saveSession } from '@/lib/server/sessions/session-repository'
import { loadUsage } from '@/lib/server/usage/usage-repository'
import { notify } from '@/lib/server/ws-hub'
import { log } from '@/lib/server/logger'
import { tryAutoRegisterSwarmFeed } from '@/lib/server/agents/agent-swarm-registration'
import type { Agent, Session } from '@/types'
import type { ServiceResult } from '@/lib/server/service-result'

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

function normalizeOllamaMode(value: unknown): Agent['ollamaMode'] {
  if (value === 'cloud') return 'cloud'
  if (value === 'local') return 'local'
  return null
}

function updateThreadShortcutSession(agentId: string, agent: Agent): void {
  if (!agent.threadSessionId) return
  const shortcut = listSessions()[agent.threadSessionId]
  if (!shortcut) return
  let changed = false
  if (shortcut.name !== agent.name) {
    shortcut.name = agent.name
    changed = true
  }
  if (shortcut.shortcutForAgentId !== agentId) {
    shortcut.shortcutForAgentId = agentId
    changed = true
  }
  if (changed) saveSession(shortcut.id, shortcut)
}

function detachAgentSessions(agentId: string): number {
  let detached = 0
  for (const session of Object.values(listSessions())) {
    if (!session || session.agentId !== agentId) continue
    session.agentId = null
    session.heartbeatEnabled = false
    saveSession(session.id, session)
    detached += 1
  }
  return detached
}

export function listAgentsForApi(): Record<string, Agent> {
  const agents = loadAgents()
  for (const agent of Object.values(agents)) {
    const hasBudget = (typeof agent.monthlyBudget === 'number' && agent.monthlyBudget > 0)
      || (typeof agent.dailyBudget === 'number' && agent.dailyBudget > 0)
      || (typeof agent.hourlyBudget === 'number' && agent.hourlyBudget > 0)
    if (!hasBudget) continue

    // Use persisted spend fields when available (push-based rollup)
    if (typeof agent.lastSpendRollupAt === 'number' && agent.lastSpendRollupAt > 0) {
      if (typeof agent.monthlyBudget === 'number' && agent.monthlyBudget > 0) agent.monthlySpend = (agent.spentMonthlyCents ?? 0) / 100
      if (typeof agent.dailyBudget === 'number' && agent.dailyBudget > 0) agent.dailySpend = (agent.spentDailyCents ?? 0) / 100
      if (typeof agent.hourlyBudget === 'number' && agent.hourlyBudget > 0) agent.hourlySpend = (agent.spentHourlyCents ?? 0) / 100
    } else {
      // Fallback: full scan for agents that predate the rollup system
      const sessions = listSessions()
      const usage = loadUsage()
      const spend = getAgentSpendWindows(agent.id, Date.now(), { sessions, usage })
      if (typeof agent.monthlyBudget === 'number' && agent.monthlyBudget > 0) agent.monthlySpend = spend.monthly
      if (typeof agent.dailyBudget === 'number' && agent.dailyBudget > 0) agent.dailySpend = spend.daily
      if (typeof agent.hourlyBudget === 'number' && agent.hourlyBudget > 0) agent.hourlySpend = spend.hourly
    }
  }
  return agents
}

export function createAgent(input: {
  body: Record<string, unknown>
  rawRecord?: Record<string, unknown> | null
}): Agent {
  const body = input.body as Record<string, unknown>
  const rawRecord = input.rawRecord || null
  const orchestratorConfig = normalizeOrchestratorConfig({
    provider: body.provider as string,
    orchestratorEnabled: body.orchestratorEnabled,
    orchestratorMission: body.orchestratorMission,
    orchestratorWakeInterval: body.orchestratorWakeInterval,
    orchestratorGovernance: body.orchestratorGovernance,
    orchestratorMaxCyclesPerDay: body.orchestratorMaxCyclesPerDay,
  })
  const capabilitySelection = resolveAgentToolSelection({
    hasExplicitTools: Boolean(rawRecord && Object.prototype.hasOwnProperty.call(rawRecord, 'tools')),
    hasExplicitExtensions: Boolean(rawRecord && Object.prototype.hasOwnProperty.call(rawRecord, 'extensions')),
    tools: Array.isArray(body.tools) ? normalizeStringList(body.tools) : undefined,
    extensions: Array.isArray(body.extensions) ? normalizeStringList(body.extensions) : undefined,
  })
  const id = genId()
  const now = Date.now()
  const agent: Agent = {
    id,
    name: String(body.name || ''),
    description: String(body.description || ''),
    soul: typeof body.soul === 'string' && body.soul ? body.soul : undefined,
    systemPrompt: String(body.systemPrompt || ''),
    provider: String(body.provider || ''),
    model: String(body.model || ''),
    ollamaMode: body.provider === 'ollama' ? (normalizeOllamaMode(body.ollamaMode) || 'local') : null,
    credentialId: (body.credentialId as string | null | undefined) || null,
    fallbackCredentialIds: normalizeStringList(body.fallbackCredentialIds),
    apiEndpoint: normalizeProviderEndpoint(String(body.provider || ''), (body.apiEndpoint as string | null | undefined) || null),
    gatewayProfileId: (body.gatewayProfileId as string | null | undefined) || null,
    preferredGatewayTags: normalizeStringList(body.preferredGatewayTags),
    preferredGatewayUseCase: typeof body.preferredGatewayUseCase === 'string' && body.preferredGatewayUseCase.trim()
      ? body.preferredGatewayUseCase.trim()
      : null,
    routingStrategy: body.routingStrategy as Agent['routingStrategy'],
    routingTargets: Array.isArray(body.routingTargets)
      ? body.routingTargets.map((target) => {
          const row = target as Record<string, unknown>
          const provider = typeof row.provider === 'string' ? row.provider : String(body.provider || '')
          return {
            ...row,
            provider,
            ollamaMode: provider === 'ollama' ? (normalizeOllamaMode(row.ollamaMode) || 'local') : null,
            apiEndpoint: normalizeProviderEndpoint(provider, (row.apiEndpoint as string | null | undefined) || null),
          }
        }) as Agent['routingTargets']
      : undefined,
    delegationEnabled: body.delegationEnabled === true,
    delegationTargetMode: body.delegationTargetMode === 'selected' ? 'selected' : 'all',
    delegationTargetAgentIds: (body.delegationTargetMode === 'selected' ? normalizeStringList(body.delegationTargetAgentIds) : []),
    tools: capabilitySelection.tools,
    extensions: capabilitySelection.extensions,
    skills: Array.isArray(body.skills) ? body.skills as Agent['skills'] : undefined,
    skillIds: normalizeStringList(body.skillIds),
    mcpServerIds: normalizeStringList(body.mcpServerIds),
    mcpDisabledTools: normalizeStringList(body.mcpDisabledTools).length ? normalizeStringList(body.mcpDisabledTools) : undefined,
    capabilities: Array.isArray(body.capabilities) ? body.capabilities as string[] : undefined,
    thinkingLevel: (body.thinkingLevel as Agent['thinkingLevel']) || undefined,
    autoRecovery: body.autoRecovery === true,
    disabled: body.disabled === true,
    heartbeatEnabled: body.heartbeatEnabled !== false,
    heartbeatInterval: body.heartbeatInterval as Agent['heartbeatInterval'],
    heartbeatIntervalSec: typeof body.heartbeatIntervalSec === 'number' ? body.heartbeatIntervalSec : null,
    heartbeatModel: typeof body.heartbeatModel === 'string' ? body.heartbeatModel : undefined,
    heartbeatPrompt: typeof body.heartbeatPrompt === 'string' ? body.heartbeatPrompt : undefined,
    orchestratorEnabled: orchestratorConfig.orchestratorEnabled,
    orchestratorMission: orchestratorConfig.orchestratorMission,
    orchestratorWakeInterval: orchestratorConfig.orchestratorWakeInterval,
    orchestratorGovernance: orchestratorConfig.orchestratorGovernance,
    orchestratorMaxCyclesPerDay: orchestratorConfig.orchestratorMaxCyclesPerDay,
    elevenLabsVoiceId: typeof body.elevenLabsVoiceId === 'string' ? body.elevenLabsVoiceId : undefined,
    monthlyBudget: typeof body.monthlyBudget === 'number' ? body.monthlyBudget : null,
    dailyBudget: typeof body.dailyBudget === 'number' ? body.dailyBudget : null,
    hourlyBudget: typeof body.hourlyBudget === 'number' ? body.hourlyBudget : null,
    budgetAction: (body.budgetAction as Agent['budgetAction']) || 'warn',
    identityState: (body.identityState as Agent['identityState']) ?? null,
    memoryScopeMode: (body.memoryScopeMode as Agent['memoryScopeMode']) || undefined,
    memoryTierPreference: (body.memoryTierPreference as Agent['memoryTierPreference']) || undefined,
    proactiveMemory: body.proactiveMemory !== false,
    autoDraftSkillSuggestions: body.autoDraftSkillSuggestions as Agent['autoDraftSkillSuggestions'],
    projectId: typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : undefined,
    avatarSeed: typeof body.avatarSeed === 'string' ? body.avatarSeed : undefined,
    avatarUrl: typeof body.avatarUrl === 'string' ? body.avatarUrl : undefined,
    sessionResetMode: (body.sessionResetMode as Agent['sessionResetMode']) ?? null,
    sessionIdleTimeoutSec: typeof body.sessionIdleTimeoutSec === 'number' ? body.sessionIdleTimeoutSec : null,
    sessionMaxAgeSec: typeof body.sessionMaxAgeSec === 'number' ? body.sessionMaxAgeSec : null,
    sessionDailyResetAt: typeof body.sessionDailyResetAt === 'string' ? body.sessionDailyResetAt : null,
    sessionResetTimezone: typeof body.sessionResetTimezone === 'string' ? body.sessionResetTimezone : null,
    sandboxConfig: normalizeAgentSandboxConfig(body.sandboxConfig),
    executeConfig: body.executeConfig === null ? null : normalizeAgentExecuteConfig(body.executeConfig),
    createdAt: now,
    updatedAt: now,
  }
  saveAgent(id, agent)
  logActivity({ entityType: 'agent', entityId: id, action: 'created', actor: 'user', summary: `Agent created: "${agent.name}"` })
  notify('agents')

  // Auto-register on SwarmFeed when created with it enabled
  if (agent.swarmfeedEnabled && !agent.swarmfeedApiKey) {
    tryAutoRegisterSwarmFeed(agent).catch((err) => {
      log.error('agent-service', `SwarmFeed auto-registration failed for "${agent.name}": ${err instanceof Error ? err.message : err}`)
    })
  }

  return agent
}

export function updateAgent(agentId: string, body: Record<string, unknown>): Agent | null {
  const updated = patchAgent(agentId, (current) => {
    if (!current) return null
    const agent = { ...current, ...body, updatedAt: Date.now() }
    if (body.tools !== undefined || body.extensions !== undefined) {
      const nextSelection = normalizeCapabilitySelection({
        tools: Array.isArray(body.tools) ? body.tools : agent.tools,
        extensions: Array.isArray(body.extensions) ? body.extensions : agent.extensions,
      })
      agent.tools = nextSelection.tools
      agent.extensions = nextSelection.extensions
    }
    if (body.delegationEnabled !== undefined) {
      agent.delegationEnabled = body.delegationEnabled === true
    }
    if (body.delegationTargetMode === 'all' || body.delegationTargetMode === 'selected') {
      agent.delegationTargetMode = body.delegationTargetMode
    }
    if (body.delegationTargetAgentIds !== undefined) {
      agent.delegationTargetAgentIds = normalizeStringList(body.delegationTargetAgentIds)
    }
    if (agent.delegationTargetMode !== 'selected') {
      agent.delegationTargetAgentIds = []
    }
    if (body.apiEndpoint !== undefined) {
      agent.apiEndpoint = normalizeProviderEndpoint(
        (body.provider as string) || agent.provider,
        body.apiEndpoint as string | null | undefined,
      )
    }
    if (body.provider !== undefined && body.provider !== 'ollama' && body.ollamaMode === undefined) {
      agent.ollamaMode = null
    }
    if (body.sandboxConfig !== undefined) {
      agent.sandboxConfig = normalizeAgentSandboxConfig(body.sandboxConfig)
    }
    if (body.executeConfig !== undefined) {
      agent.executeConfig = body.executeConfig === null ? null : normalizeAgentExecuteConfig(body.executeConfig)
    }
    if (
      body.provider !== undefined
      || body.orchestratorEnabled !== undefined
      || body.orchestratorMission !== undefined
      || body.orchestratorWakeInterval !== undefined
      || body.orchestratorGovernance !== undefined
      || body.orchestratorMaxCyclesPerDay !== undefined
    ) {
      const orchestratorConfig = normalizeOrchestratorConfig({
        provider: typeof body.provider === 'string' ? body.provider : agent.provider,
        orchestratorEnabled: body.orchestratorEnabled ?? agent.orchestratorEnabled,
        orchestratorMission: body.orchestratorMission ?? agent.orchestratorMission,
        orchestratorWakeInterval: body.orchestratorWakeInterval ?? agent.orchestratorWakeInterval,
        orchestratorGovernance: body.orchestratorGovernance ?? agent.orchestratorGovernance,
        orchestratorMaxCyclesPerDay: body.orchestratorMaxCyclesPerDay ?? agent.orchestratorMaxCyclesPerDay,
      })
      agent.orchestratorEnabled = orchestratorConfig.orchestratorEnabled
      agent.orchestratorMission = orchestratorConfig.orchestratorMission
      agent.orchestratorWakeInterval = orchestratorConfig.orchestratorWakeInterval
      agent.orchestratorGovernance = orchestratorConfig.orchestratorGovernance
      agent.orchestratorMaxCyclesPerDay = orchestratorConfig.orchestratorMaxCyclesPerDay
    }
    if (body.preferredGatewayTags !== undefined) {
      agent.preferredGatewayTags = normalizeStringList(body.preferredGatewayTags)
    }
    if (body.preferredGatewayUseCase !== undefined) {
      agent.preferredGatewayUseCase = typeof body.preferredGatewayUseCase === 'string' && body.preferredGatewayUseCase.trim()
        ? body.preferredGatewayUseCase.trim()
        : null
    }
    if (body.routingTargets !== undefined && Array.isArray(body.routingTargets)) {
      agent.routingTargets = body.routingTargets.map((target, index) => {
        const row = target as Record<string, unknown>
        const provider = typeof row.provider === 'string' && row.provider.trim() ? row.provider : agent.provider
        return {
          id: typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `route-${index + 1}`,
          label: typeof row.label === 'string' ? row.label : undefined,
          role: row.role,
          provider,
          model: typeof row.model === 'string' ? row.model : '',
          ollamaMode: provider === 'ollama'
            ? (row.ollamaMode === 'cloud' ? 'cloud' : 'local')
            : null,
          credentialId: row.credentialId ?? null,
          fallbackCredentialIds: Array.isArray(row.fallbackCredentialIds) ? row.fallbackCredentialIds : [],
          apiEndpoint: normalizeProviderEndpoint(
            provider,
            typeof row.apiEndpoint === 'string' ? row.apiEndpoint : null,
          ),
          gatewayProfileId: row.gatewayProfileId ?? null,
          preferredGatewayTags: normalizeStringList(row.preferredGatewayTags),
          preferredGatewayUseCase: typeof row.preferredGatewayUseCase === 'string' && row.preferredGatewayUseCase.trim()
            ? row.preferredGatewayUseCase.trim()
            : null,
          priority: typeof row.priority === 'number' ? row.priority : index + 1,
        }
      }) as Agent['routingTargets']
    }
    delete (agent as Record<string, unknown>).platformAssignScope
    delete (agent as Record<string, unknown>).subAgentIds
    delete (agent as Record<string, unknown>).id
    agent.id = agentId
    return agent as Agent
  })
  if (!updated) return null

  if (updated.threadSessionId) {
    ensureAgentThreadSession(agentId)
    updateThreadShortcutSession(agentId, updated)
  }

  const budgetFields = ['monthlyBudget', 'dailyBudget', 'hourlyBudget', 'budgetAction'] as const
  const budgetChanges: Record<string, unknown> = {}
  for (const key of budgetFields) {
    if (key in body) budgetChanges[key] = body[key]
  }
  const detail: Record<string, unknown> = {}
  if (Object.keys(budgetChanges).length > 0) detail.budgetChanges = budgetChanges
  logActivity({ entityType: 'agent', entityId: agentId, action: 'updated', actor: 'user', summary: `Agent updated: "${updated.name}"`, detail: Object.keys(detail).length > 0 ? detail : undefined })
  if (Object.keys(budgetChanges).length > 0) {
    logActivity({ entityType: 'budget', entityId: agentId, action: 'configured', actor: 'user', summary: `Budget updated for agent "${updated.name}"`, detail: budgetChanges })
  }

  // Auto-register on SwarmFeed/SwarmDock when enabled without existing credentials
  if (updated.swarmfeedEnabled && !updated.swarmfeedApiKey) {
    tryAutoRegisterSwarmFeed(updated).catch((err) => {
      log.error('agent-service', `SwarmFeed auto-registration failed for "${updated.name}": ${err instanceof Error ? err.message : err}`)
    })
  }

  return updated
}

export function trashAgent(agentId: string): { ok: false } | { ok: true; detachedSessions: number; cascade: ReturnType<typeof suspendAgentReferences> } {
  const trashed = patchAgent(agentId, (current) => {
    if (!current) return null
    return { ...current, trashedAt: Date.now() }
  })
  if (!trashed) return { ok: false }

  logActivity({ entityType: 'agent', entityId: agentId, action: 'deleted', actor: 'user', summary: `Agent trashed: "${trashed.name}"` })
  const detachedSessions = detachAgentSessions(agentId)
  const cascade = suspendAgentReferences(agentId)
  return { ok: true, detachedSessions, cascade }
}

export function restoreTrashedAgent(agentId: string): Agent | null {
  const agent = patchAgent(agentId, (current) => {
    if (!current || !current.trashedAt) return null
    const next = { ...current }
    delete next.trashedAt
    next.updatedAt = Date.now()
    return next
  })
  if (!agent) return null
  notify('agents')
  const restoredSchedules = restoreAgentSchedules(agentId)
  if (restoredSchedules) notify('schedules')
  return agent
}

export function permanentlyDeleteTrashedAgent(agentId: string): { ok: false; reason: 'not_found' | 'not_trashed' } | { ok: true; purged: ReturnType<typeof purgeAgentReferences> } {
  const agent = loadAgents({ includeTrashed: true })[agentId]
  if (!agent) return { ok: false, reason: 'not_found' }
  if (!agent.trashedAt) return { ok: false, reason: 'not_trashed' }

  const purged = purgeAgentReferences(agentId)
  deleteAgent(agentId)
  notify('agents')
  return { ok: true, purged }
}

export function cloneAgent(agentId: string): Agent | null {
  const source = loadAgents({ includeTrashed: true })[agentId]
  if (!source) return null
  const newId = crypto.randomUUID()
  const now = Date.now()
  const cloned = JSON.parse(JSON.stringify(source)) as Agent
  cloned.id = newId
  cloned.name = `${source.name} (Copy)`
  cloned.createdAt = now
  cloned.updatedAt = now
  cloned.totalCost = 0
  cloned.lastUsedAt = undefined
  cloned.threadSessionId = null
  cloned.pinned = false
  cloned.trashedAt = undefined

  saveAgent(newId, cloned)
  logActivity({
    entityType: 'agent',
    entityId: newId,
    action: 'created',
    actor: 'user',
    summary: `Agent cloned from "${source.name}": "${cloned.name}"`,
  })
  notify('agents')
  return cloned
}

export function bulkPatchAgents(patches: unknown): { updated: number; errors: string[] } {
  if (!Array.isArray(patches) || patches.length === 0) {
    return { updated: 0, errors: ['patches must be a non-empty array'] }
  }
  let updated = 0
  const errors: string[] = []
  for (const entry of patches) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push('Invalid patch entry (not an object)')
      continue
    }
    const { id, patch } = entry as { id?: unknown; patch?: unknown }
    if (typeof id !== 'string' || !id.trim()) {
      errors.push('Patch entry missing valid id')
      continue
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      errors.push(`Patch for ${id} is not a valid object`)
      continue
    }
    const result = patchAgent(id, (current) => current ? { ...current, ...(patch as Record<string, unknown>), updatedAt: Date.now() } : null)
    if (!result) {
      errors.push(`Agent ${id} not found`)
      continue
    }
    updated += 1
    logActivity({
      entityType: 'agent',
      entityId: id,
      action: 'updated',
      actor: 'user',
      summary: `Bulk patch: updated agent "${result.name || id}"`,
    })
  }
  if (updated > 0) notify('agents')
  return { updated, errors }
}

export function getAgentThreadSession(agentId: string, user = 'default'): ServiceResult<Session> {
  const agent = loadAgents()[agentId]
  if (!agent) {
    return serviceFail(404, 'Agent not found')
  }
  const session = ensureAgentThreadSession(agentId, user, agent)
  if (!session) {
    if (isAgentDisabled(agent)) {
      return serviceFail(409, buildAgentDisabledMessage(agent, 'start new chats'))
    }
    return serviceFail(404, 'Agent not found')
  }
  return serviceOk(session)
}

export function getAgentStatus(agentId: string): Agent | null {
  return loadAgents()[agentId] || null
}

export function listTrashedAgentsForApi(): Record<string, Agent> {
  return loadTrashedAgents()
}
