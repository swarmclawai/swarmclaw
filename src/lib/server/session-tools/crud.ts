import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { genId } from '@/lib/id'
import {
  loadAgents, saveAgents,
  loadProjects, saveProjects,
  loadTasks, saveTasks,
  loadSchedules, saveSchedules,
  loadSkills, saveSkills,
  loadConnectors, saveConnectors,
  loadWebhooks, saveWebhooks,
  loadSecrets, saveSecrets,
  loadSessions,
  loadSettings,
  encryptKey,
  decryptKey,
} from '../storage'
import { getMessages } from '@/lib/server/messages/message-repository'
import { resolveScheduleName } from '@/lib/schedules/schedule-name'
import type { ScheduleLike } from '@/lib/schedules/schedule-dedupe'
import {
  hasManagedAgentAssignmentInput,
  isDelegationTaskPayload,
  resolveDelegatorAgentId,
  resolveManagedAgentAssignment,
  validateManagedAgentAssignment,
} from '@/lib/server/agents/agent-assignment'
import { buildProjectSnapshot, ensureProjectWorkspace, normalizeProjectCreateInput, normalizeProjectPatchInput } from '@/lib/server/project-utils'
import {
  getScheduleClusterIds,
  prepareScheduleCreate,
  prepareScheduleUpdate,
} from '@/lib/server/schedules/schedule-service'
import { archiveScheduleCluster } from '@/lib/server/schedules/schedule-lifecycle'
import {
  applyTaskContinuationDefaults,
  applyTaskPatch,
  deriveTaskTitle,
  prepareTaskCreation,
} from '@/lib/server/tasks/task-service'
import { ensureMissionForTask, enrichTaskWithMissionSummary } from '@/lib/server/missions/mission-service'
import { classifyMessage } from '@/lib/server/chat-execution/message-classifier'
import {
  buildDelegationTaskProfile,
  formatDelegationRationale,
  resolveDelegationAdvisory,
} from '@/lib/server/agents/delegation-advisory'
import type { ToolBuildContext } from './context'
import { normalizeToolInputArgs } from './normalize-tool-args'
import type { BoardTask } from '@/types'
import { dedup } from '@/lib/shared-utils'
import { isDirectConnectorSession } from '../connectors/session-kind'
import { buildManageSkillsDescription, executeManageSkillsAction } from './skills'
import { isMainSession } from '@/lib/server/agents/main-agent-loop'
import { findCredentialTemplate, buildCredentialRequestMessage } from '@/lib/credential-registry'
import { createWatchJob } from '@/lib/server/runtime/watch-jobs'

function validateAgentSoulPayload(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value === 'string') return null
  return 'Error: manage_agents data.soul must be a plain instruction string. Use memory tools for user preferences, durable facts, and long-term memory instead.'
}

function findDuplicateManagedAgent(
  all: Record<string, unknown>,
  parsed: Record<string, unknown>,
  ctx?: ToolBuildContext['ctx'],
): Record<string, unknown> | null {
  const requestedId = typeof parsed.id === 'string' ? parsed.id.trim() : ''
  const requestedName = typeof parsed.name === 'string' ? parsed.name.trim().toLowerCase() : ''
  if (!requestedId && !requestedName) return null

  for (const candidate of Object.values(all)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const record = candidate as Record<string, unknown>
    if (requestedId && String(record.id || '').trim() === requestedId) return record
    if (!requestedName) continue
    const sameName = String(record.name || '').trim().toLowerCase() === requestedName
    const sameSession = ctx?.sessionId && record.createdInSessionId === ctx.sessionId
    if (sameName && sameSession) return record
  }

  return null
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    const trimmed = typeof entry === 'string' ? entry.trim() : ''
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

function buildTaskDelegationText(parsed: Record<string, unknown>): string {
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
  const description = typeof parsed.description === 'string' ? parsed.description.trim() : ''
  return [title, description].filter(Boolean).join('\n\n').trim()
}

async function resolveManagedTaskDelegation(params: {
  parsed: Record<string, unknown>
  agents: ReturnType<typeof loadAgents>
  ctx?: ToolBuildContext['ctx']
  assignedAgentId: string | null
  explicitAssignment: boolean
  allowAutoAssignment: boolean
}): Promise<{
  assignedAgentId: string | null
  advisory: Record<string, unknown> | null
}> {
  const currentAgentId = typeof params.ctx?.agentId === 'string' ? params.ctx.agentId.trim() : ''
  if (!currentAgentId || params.ctx?.delegationEnabled !== true) {
    return { assignedAgentId: params.assignedAgentId, advisory: null }
  }
  const currentAgent = params.agents[currentAgentId]
  if (!currentAgent) {
    return { assignedAgentId: params.assignedAgentId, advisory: null }
  }

  const explicitCapabilities = normalizeStringList(params.parsed.requiredCapabilities)
  const classificationText = buildTaskDelegationText(params.parsed)
  const classification = (!explicitCapabilities.length && classificationText && params.ctx?.sessionId)
    ? await classifyMessage({
        sessionId: params.ctx.sessionId,
        agentId: currentAgentId,
        message: classificationText,
      }).catch(() => null)
    : null

  const profile = buildDelegationTaskProfile({
    classification,
    requiredCapabilities: explicitCapabilities,
  })
  if (!profile.substantial) {
    return { assignedAgentId: params.assignedAgentId, advisory: null }
  }

  const delegationAdvisory = resolveDelegationAdvisory({
    currentAgent,
    agents: params.agents,
    profile,
    delegationTargetMode: params.ctx?.delegationTargetMode === 'selected' ? 'selected' : 'all',
    delegationTargetAgentIds: params.ctx?.delegationTargetAgentIds || [],
  })
  const recommended = delegationAdvisory.recommended
  if (!delegationAdvisory.shouldDelegate || !recommended) {
    return { assignedAgentId: params.assignedAgentId, advisory: null }
  }
  if (params.explicitAssignment && params.assignedAgentId === recommended.agentId) {
    return { assignedAgentId: params.assignedAgentId, advisory: null }
  }

  let assignedAgentId = params.assignedAgentId
  let autoAssigned = false
  if (!params.explicitAssignment && params.allowAutoAssignment) {
    assignedAgentId = recommended.agentId
    autoAssigned = true
  }

  return {
    assignedAgentId,
    advisory: {
      recommendedAgentId: recommended.agentId,
      recommendedAgentName: recommended.agentName,
      rationale: formatDelegationRationale(recommended),
      workType: profile.workType,
      requiredCapabilities: profile.requiredCapabilities,
      autoAssigned,
    },
  }
}

const VALID_CONNECTOR_PLATFORMS = new Set([
  'discord',
  'telegram',
  'slack',
  'whatsapp',
  'openclaw',
  'bluebubbles',
  'signal',
  'teams',
  'googlechat',
  'matrix',
  'email',
  'webchat',
  'mockmail',
])

const VALID_CONNECTOR_STATUSES = new Set(['stopped', 'running', 'error'])

function normalizeConnectorConfig(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedKey = typeof key === 'string' ? key.trim() : ''
    if (!normalizedKey) continue
    if (typeof value === 'string') {
      normalized[normalizedKey] = value
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      normalized[normalizedKey] = String(value)
    }
  }
  return normalized
}

function sanitizeConnectorCrudPayload(
  raw: Record<string, unknown>,
  options: { forUpdate?: boolean } = {},
): Record<string, unknown> {
  const { forUpdate = false } = options
  const out: Record<string, unknown> = {}
  const setString = (key: 'name' | 'platform' | 'status') => {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return
    const value = typeof raw[key] === 'string' ? raw[key].trim() : ''
    if (!value) return
    if (key === 'platform' && !VALID_CONNECTOR_PLATFORMS.has(value)) return
    if (key === 'status' && !VALID_CONNECTOR_STATUSES.has(value)) return
    out[key] = value
  }
  const setNullableId = (key: 'agentId' | 'chatroomId' | 'credentialId') => {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return
    const value = typeof raw[key] === 'string' ? raw[key].trim() : ''
    out[key] = value || null
  }

  setString('name')
  setString('platform')
  setString('status')
  setNullableId('agentId')
  setNullableId('chatroomId')
  setNullableId('credentialId')

  if (Object.prototype.hasOwnProperty.call(raw, 'config')) {
    out.config = normalizeConnectorConfig(raw.config)
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'isEnabled')) {
    out.isEnabled = raw.isEnabled === true
  } else if (Object.prototype.hasOwnProperty.call(raw, 'enabled')) {
    out.isEnabled = raw.enabled === true
  }

  if (!forUpdate) {
    const platform = typeof out.platform === 'string' ? out.platform : 'discord'
    return {
      name: typeof out.name === 'string' && out.name ? out.name : 'Unnamed Connector',
      platform,
      agentId: Object.prototype.hasOwnProperty.call(out, 'agentId') ? out.agentId : null,
      chatroomId: Object.prototype.hasOwnProperty.call(out, 'chatroomId') ? out.chatroomId : null,
      credentialId: Object.prototype.hasOwnProperty.call(out, 'credentialId') ? out.credentialId : null,
      config: Object.prototype.hasOwnProperty.call(out, 'config') ? out.config : {},
      isEnabled: Object.prototype.hasOwnProperty.call(out, 'isEnabled') ? out.isEnabled : false,
      ...(typeof out.status === 'string' ? { status: out.status } : {}),
    }
  }

  return out
}

function deriveScheduleFollowupTarget(sessionId: string | null | undefined): {
  followupConnectorId?: string | null
  followupChannelId?: string | null
  followupThreadId?: string | null
  followupSenderId?: string | null
  followupSenderName?: string | null
} {
  const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!normalizedSessionId) return {}

  const session = loadSessions()[normalizedSessionId] as unknown as {
    connectorContext?: Record<string, unknown>
    messages?: Array<Record<string, unknown>>
  } | undefined
  if (!session) return {}

  const pickSourceFields = (source: Record<string, unknown> | null | undefined) => {
    const connectorId = typeof source?.connectorId === 'string' ? source.connectorId.trim() : ''
    const channelId = typeof source?.channelId === 'string' ? source.channelId.trim() : ''
    if (!connectorId || !channelId) return {}
    const threadId = typeof source?.threadId === 'string' ? source.threadId.trim() : ''
    const senderId = typeof source?.senderId === 'string' ? source.senderId.trim() : ''
    const senderName = typeof source?.senderName === 'string' ? source.senderName.trim() : ''
    return {
      followupConnectorId: connectorId,
      followupChannelId: channelId,
      followupThreadId: threadId || null,
      followupSenderId: senderId || null,
      followupSenderName: senderName || null,
    }
  }

  if (isDirectConnectorSession(session as { user?: string; name?: string })) {
    const contextTarget = pickSourceFields(session.connectorContext || undefined)
    if (contextTarget.followupConnectorId && contextTarget.followupChannelId) return contextTarget
  }
  if (session.connectorContext?.isOwnerConversation === true) {
    const ownerTarget = pickSourceFields(session.connectorContext || undefined)
    if (ownerTarget.followupConnectorId && ownerTarget.followupChannelId) return ownerTarget
  }

  if (isMainSession(session)) return {}

  const messages = getMessages(normalizedSessionId)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if ((typeof message?.role === 'string' ? message.role : '') !== 'user') continue
    if (message?.historyExcluded === true) continue
    const messageTarget = pickSourceFields(message?.source as Record<string, unknown> | undefined)
    if (messageTarget.followupConnectorId && messageTarget.followupChannelId) return messageTarget
  }

  return {}
}

// ---------------------------------------------------------------------------
// RESOURCE_DEFAULTS
// ---------------------------------------------------------------------------

const RESOURCE_DEFAULTS: Record<string, (parsed: any) => any> = {
  manage_agents: (p) => ({
    name: p.name || 'Unnamed Agent',
    description: p.description || '',
    systemPrompt: p.systemPrompt || '',
    soul: p.soul || '',
    provider: p.provider || 'claude-cli',
    model: p.model || '',
    delegationEnabled: p.delegationEnabled === true,
    delegationTargetMode: p.delegationTargetMode === 'selected' ? 'selected' : 'all',
    tools: p.tools || [],
    skills: p.skills || [],
    skillIds: p.skillIds || [],
    delegationTargetAgentIds: p.delegationTargetMode === 'selected' ? (p.delegationTargetAgentIds || []) : [],
    ...p,
  }),
  manage_tasks: (p) => ({
    title: deriveTaskTitle(p) || 'Untitled Task',
    description: p.description || '',
    status: p.status || 'backlog',
    agentId: p.agentId || null,
    sessionId: p.sessionId || null,
    result: null,
    error: null,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    priority: ['low', 'medium', 'high', 'critical'].includes(p.priority) ? p.priority : undefined,
    ...p,
  }),
  manage_schedules: (p) => {
    const now = Date.now()
    const base = {
      name: resolveScheduleName({ name: p.name, taskPrompt: p.taskPrompt }),
      agentId: p.agentId || null,
      taskPrompt: p.taskPrompt || '',
      scheduleType: p.scheduleType || 'interval',
      status: p.status || 'active',
      ...p,
    }
    if (!base.nextRunAt) {
      if (base.scheduleType === 'once' && base.runAt) base.nextRunAt = base.runAt
      else if (base.scheduleType === 'interval' && base.intervalMs) base.nextRunAt = now + base.intervalMs
    }
    return base
  },
  manage_skills: (p) => ({
    name: p.name || 'Unnamed Skill',
    description: p.description || '',
    content: p.content || '',
    filename: p.filename || '',
    ...p,
  }),
  manage_connectors: (p) => ({
    ...sanitizeConnectorCrudPayload(p as Record<string, unknown>),
  }),
  manage_webhooks: (p) => ({
    name: p.name || 'Unnamed Webhook',
    source: p.source || 'custom',
    events: Array.isArray(p.events) ? p.events : [],
    agentId: p.agentId || null,
    secret: p.secret || '',
    isEnabled: p.isEnabled ?? true,
    ...p,
  }),
  manage_secrets: (p) => ({
    name: p.name || 'Unnamed Secret',
    service: p.service || 'custom',
    scope: p.scope || 'global',
    agentIds: Array.isArray(p.agentIds) ? p.agentIds : [],
    ...p,
  }),
  manage_projects: (p) => normalizeProjectCreateInput(p),
}

// ---------------------------------------------------------------------------
// PLATFORM_RESOURCES
// ---------------------------------------------------------------------------

const PLATFORM_RESOURCES: Record<string, {
  toolId: string
  label: string
  load: () => Record<string, any>
  save: (d: Record<string, any>) => void
  readOnly?: boolean
}> = {
  manage_agents: { toolId: 'manage_agents', label: 'agents', load: loadAgents, save: saveAgents },
  manage_projects: { toolId: 'manage_projects', label: 'projects', load: loadProjects, save: saveProjects },
  manage_tasks: { toolId: 'manage_tasks', label: 'tasks', load: loadTasks, save: saveTasks },
  manage_schedules: { toolId: 'manage_schedules', label: 'schedules', load: loadSchedules, save: saveSchedules },
  manage_skills: { toolId: 'manage_skills', label: 'skills', load: loadSkills, save: saveSkills },
  manage_connectors: { toolId: 'manage_connectors', label: 'connectors', load: loadConnectors, save: saveConnectors },
  manage_webhooks: { toolId: 'manage_webhooks', label: 'webhooks', load: loadWebhooks, save: saveWebhooks },
  manage_secrets: { toolId: 'manage_secrets', label: 'secrets', load: loadSecrets, save: saveSecrets },
}

// ---------------------------------------------------------------------------
// buildCrudTools
// ---------------------------------------------------------------------------

export function buildCrudTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { cwd, ctx, hasExtension } = bctx
  const buildCrudPayload = (normalized: Record<string, unknown>, action: string | undefined, data: string | undefined): Record<string, unknown> => {
    if (data) return JSON.parse(data)
    if (action !== 'create' && action !== 'update') return {}
    const entries = Object.entries(normalized).filter(([key]) =>
      !['action', 'id', 'data', 'resource', 'input', 'args', 'arguments', 'payload', 'parameters'].includes(key),
    )
    return entries.length > 0 ? Object.fromEntries(entries) : {}
  }

  // Build dynamic agent summary for tools that need agent awareness
  const canAssignOtherAgents = ctx?.delegationEnabled === true
  let agentSummary = ''
  if (hasExtension('manage_tasks') || hasExtension('manage_schedules')) {
    if (canAssignOtherAgents) {
      try {
        const agents = loadAgents()
        const agentList = Object.values(agents)
          .map((a: any) => `  - "${a.id}": ${a.name}${a.description ? ` — ${a.description}` : ''}`)
          .join('\n')
        if (agentList) agentSummary = `\n\nAvailable agents:\n${agentList}`
      } catch { /* ignore */ }
    }
  }

  for (const [toolKey, res] of Object.entries(PLATFORM_RESOURCES)) {
    if (!hasExtension(toolKey)) continue

    let description = `Manage SwarmClaw ${res.label}. ${res.readOnly ? 'List and get only.' : 'List, get, create, update, or delete.'} Returns JSON.`
    if (toolKey.startsWith('manage_') && toolKey !== 'manage_platform') {
      description += `\n\nUse this direct tool name exactly as shown (\`${toolKey}\`). Do not swap it for \`manage_platform\` unless that umbrella tool is separately enabled in the current session.`
    }
    if (toolKey === 'manage_tasks') {
      if (!canAssignOtherAgents) {
        description += `\n\nYou may create tasks for yourself ("${ctx?.agentId || 'unknown'}") or leave them unassigned to track multi-step work. You cannot assign tasks to other agents unless a user enables "Assign to Other Agents" in your agent settings. Valid manual statuses: backlog, queued, completed, failed, archived. "running" is runtime-only and set automatically when execution starts.`
      } else {
        description += `\n\nYou may create tasks for yourself, leave them unassigned, or delegate them to other agents. Your agent ID is "${ctx?.agentId || 'unknown'}". When delegating, set a target agent using "agentId", "assignee", "agent", "assignedAgentId", or "assigned_agent_id". Use the target agent's exact ID when possible. Valid manual statuses: backlog, queued, completed, failed, archived. "running" is runtime-only and set automatically when execution starts.` + agentSummary
      }
      description += '\n\nCreate/update calls accept either `data` as a JSON string or direct top-level fields like `title`, `description`, `status`, `agentId`, and `projectId`.'
      if (canAssignOtherAgents) {
        description += '\n\nWhen you omit an assignee, the runtime may auto-assign the task to a materially better-fit teammate based on `requiredCapabilities` or the classified work type. If you set an explicit assignee, it is respected in v1, but the response may include `delegationAdvisory` when another teammate is a better fit.'
      }
      description += '\n\nFor follow-up work, set `continueFromTaskId` (or `followUpToTaskId`) to a prior task ID. The new task will inherit the predecessor\'s project/agent/session context, block on that task by default, and reuse its execution session when possible.'
      if (ctx?.projectId) {
        description += `\n\nCurrent project context: "${ctx.projectName || ctx.projectId}" (projectId "${ctx.projectId}"). Omit "projectId" to use this active project by default.`
      }
    } else if (toolKey === 'manage_projects') {
      description += '\n\nProjects hold durable execution context for longer-lived work: objective, audience, pilot priorities, open objectives, credential requirements, and preferred heartbeat cadence.'
      description += '\n\nCreate/update calls accept either `data` as a JSON string or direct top-level fields like `name`, `description`, `objective`, `audience`, `priorities`, `openObjectives`, `capabilityHints`, `credentialRequirements`, `heartbeatPrompt`, and `heartbeatIntervalSec`.'
      if (ctx?.projectId) {
        description += `\n\nCurrent project context: "${ctx.projectName || ctx.projectId}" (projectId "${ctx.projectId}"). For get/update/delete, you may omit "id" to target this active project.`
      }
    } else if (toolKey === 'manage_agents') {
      description += `\n\nAgents may self-edit their own soul only when explicitly changing persona or operating instructions. Do not use manage_agents to store user preferences, durable facts, or normal memory; use the memory tools for that. To update your soul, use action="update", id="${ctx?.agentId || 'your-agent-id'}", and include data with the "soul" field. Set "delegationEnabled":true to let an agent delegate work across the fleet. Use "delegationTargetMode":"selected" plus "delegationTargetAgentIds" to limit which agents it may delegate to.`
    } else if (toolKey === 'manage_schedules') {
      if (!canAssignOtherAgents) {
        description += `\n\nOmit "agentId" to assign a schedule to yourself ("${ctx?.agentId || 'unknown'}"), or set it explicitly to yourself. You can only assign schedules to yourself. Schedule types: interval (set intervalMs), cron (set cron), once (set runAt). Provide either taskPrompt, command, or action+path. Before create, call list/get to avoid duplicate schedules. Reuse or update an existing schedule you already created in this chat instead of making a near-duplicate. If an equivalent active/paused schedule already exists, create returns that existing schedule (deduplicated=true). For one-off reminders, prefer "once"; agent-created one-off schedules are cleaned up automatically after they finish. When the user says stop/pause/cancel a reminder, pause or delete every matching schedule you created in this chat, not just one row.`
      } else {
        description += `\n\nOmit "agentId" to assign a schedule to yourself ("${ctx?.agentId || 'unknown'}"), or set "agentId" to another agent when needed. Schedule types: interval (set intervalMs), cron (set cron), once (set runAt). Provide either taskPrompt, command, or action+path. Before create, call list/get to avoid duplicate schedules. Reuse or update an existing schedule you already created in this chat instead of making a near-duplicate. If an equivalent active/paused schedule already exists, create returns that existing schedule (deduplicated=true). For one-off reminders, prefer "once"; agent-created one-off schedules are cleaned up automatically after they finish. When the user says stop/pause/cancel a reminder, pause or delete every matching schedule you created in this chat, not just one row.` + agentSummary
      }
      if (ctx?.projectId) {
        description += `\n\nCurrent project context: "${ctx.projectName || ctx.projectId}" (projectId "${ctx.projectId}"). Omit "projectId" to use this active project by default.`
      }
    } else if (toolKey === 'manage_webhooks') {
      description += '\n\nUse `source`, `events`, `agentId`, and `secret` when creating webhooks. Inbound calls should POST to `/api/webhooks/{id}` with header `x-webhook-secret` when a secret is configured.'
    } else if (toolKey === 'manage_secrets') {
      description += '\n\nUse this only for credential bootstrapping and sensitive secret storage such as API keys, passwords, tokens, recovery codes, and webhook secrets. Do not use it for normal memory, user preferences, durable facts, or project notes. Create/update calls accept either `data` as JSON or direct top-level fields like `name`, `service`, `value`, `scope`, `agentIds`, and `projectId`.'
      description += '\n\nCredential self-service workflow — when you need a credential:'
      description += '\n1. CHECK: manage_secrets(action="check", service="<name>") — looks up existing credentials and returns the service template'
      description += '\n2. REQUEST: manage_secrets(action="request", service="<name>", reason="<why>") — if not found, sends a structured request to the human with signup/key URLs and registers a durable wait'
      description += '\n3. Never report a credential blocker without first using check and then request.'
      if (ctx?.projectId) {
        description += `\n\nCurrent project context: "${ctx.projectName || ctx.projectId}" (projectId "${ctx.projectId}"). Omit "projectId" to link the secret to this active project.`
      }
    } else if (toolKey === 'manage_skills') {
      description = buildManageSkillsDescription()
    }

    tools.push(
      tool(
        async (rawArgs) => {
          const normalized = normalizeToolInputArgs((rawArgs ?? {}) as Record<string, unknown>)
          if (toolKey === 'manage_skills') {
            return executeManageSkillsAction(normalized, bctx)
          }
          const action = normalized.action as string | undefined
          const id = normalized.id as string | undefined
          const data = normalized.data as string | undefined
          const canAccessSecret = (secret: any): boolean => {
            if (!secret) return false
            if (secret.scope !== 'agent') return true
            if (!ctx?.agentId) return false
            return Array.isArray(secret.agentIds) && secret.agentIds.includes(ctx.agentId)
          }
          try {
            if (action === 'list') {
              if (toolKey === 'manage_projects') {
                const values = Object.values(res.load())
                  .map((project: any) => buildProjectSnapshot(project))
                return JSON.stringify(values)
              }
              if (toolKey === 'manage_secrets') {
                const values = Object.values(res.load())
                  .filter((s: any) => canAccessSecret(s))
                  .map((s: any) => ({
                    id: s.id,
                    name: s.name,
                    service: s.service,
                    scope: s.scope || 'global',
                    agentIds: s.agentIds || [],
                    projectId: s.projectId || null,
                    createdAt: s.createdAt,
                    updatedAt: s.updatedAt,
                  }))
                return JSON.stringify(values)
              }
              return JSON.stringify(Object.values(res.load()))
            }
            if (action === 'get') {
              const effectiveId = id || (toolKey === 'manage_projects' ? ctx?.projectId || undefined : undefined)
              if (!effectiveId) return 'Error: "id" is required for get action.'
              const all = res.load()
              if (!all[effectiveId]) return `Not found: ${res.label} "${effectiveId}"`
              if (toolKey === 'manage_projects') {
                return JSON.stringify(buildProjectSnapshot(all[effectiveId]))
              }
              if (toolKey === 'manage_secrets') {
                if (!canAccessSecret(all[effectiveId])) return 'Error: you do not have access to this secret.'
                let value = ''
                try {
                  value = all[effectiveId].encryptedValue ? decryptKey(all[effectiveId].encryptedValue) : ''
                } catch {
                  value = ''
                }
                return JSON.stringify({
                  id: all[effectiveId].id,
                  name: all[effectiveId].name,
                  service: all[effectiveId].service,
                  scope: all[effectiveId].scope || 'global',
                  agentIds: all[effectiveId].agentIds || [],
                  projectId: all[effectiveId].projectId || null,
                  value,
                  createdAt: all[effectiveId].createdAt,
                  updatedAt: all[effectiveId].updatedAt,
                })
              }
              return JSON.stringify(all[effectiveId])
            }
            if (res.readOnly) return `Cannot ${action} ${res.label} via this tool (read-only).`
            if (action === 'create') {
              const all = res.load()
              const raw = buildCrudPayload(normalized, action, data)
              const defaults = RESOURCE_DEFAULTS[toolKey]
              const parsed = defaults ? defaults(raw) : raw
              if (parsed && typeof parsed === 'object' && 'id' in parsed) {
                delete (parsed as Record<string, unknown>).id
              }
              const now = Date.now()
              if (toolKey === 'manage_tasks') {
                const continuationError = applyTaskContinuationDefaults(
                  parsed as Record<string, unknown>,
                  all as Record<string, BoardTask>,
                  raw as Record<string, unknown>,
                )
                if (continuationError) return continuationError
              }
              if ((toolKey === 'manage_tasks' || toolKey === 'manage_schedules' || toolKey === 'manage_secrets') && !Object.prototype.hasOwnProperty.call(parsed, 'projectId') && ctx?.projectId) {
                parsed.projectId = ctx.projectId
              }
              let taskDelegationAdvisory: Record<string, unknown> | null = null
              if (toolKey === 'manage_tasks' || toolKey === 'manage_schedules') {
                const agents = loadAgents()
                const resolution = resolveManagedAgentAssignment(
                  parsed as Record<string, unknown>,
                  agents,
                  toolKey === 'manage_tasks' || toolKey === 'manage_schedules'
                    ? (parsed.agentId || ctx?.agentId || null)
                    : null,
                  { allowDescription: toolKey === 'manage_tasks' },
                )
                const assignmentError = validateManagedAgentAssignment({
                  resourceLabel: res.label,
                  agents,
                  assignScope: canAssignOtherAgents ? 'all' : 'self',
                  currentAgentId: ctx?.agentId || null,
                  targetAgentId: resolution.agentId,
                  unresolvedReference: resolution.unresolvedReference,
                  isDelegation: toolKey === 'manage_tasks' ? isDelegationTaskPayload(parsed as Record<string, unknown>) : false,
                  delegatorAgentId: toolKey === 'manage_tasks'
                    ? resolveDelegatorAgentId(parsed as Record<string, unknown>, agents, ctx?.agentId || null)
                    : null,
                })
                if (assignmentError) return assignmentError
                parsed.agentId = resolution.agentId
                if (toolKey === 'manage_tasks') {
                  const delegated = await resolveManagedTaskDelegation({
                    parsed: parsed as Record<string, unknown>,
                    agents,
                    ctx,
                    assignedAgentId: resolution.agentId,
                    explicitAssignment: resolution.source === 'explicit',
                    allowAutoAssignment: true,
                  })
                  parsed.agentId = delegated.assignedAgentId
                  taskDelegationAdvisory = delegated.advisory
                }
              }
              let preparedManagedTask: BoardTask | null = null
              let preparedManagedSchedule: any = null
              if (toolKey === 'manage_schedules') {
                const prepared = prepareScheduleCreate({
                  input: parsed as Record<string, unknown>,
                  schedules: all as Record<string, ScheduleLike>,
                  now,
                  cwd,
                  creatorScope: {
                    agentId: ctx?.agentId || null,
                    sessionId: ctx?.sessionId || null,
                  },
                  dedupeCreatorScope: {
                    agentId: ctx?.agentId || null,
                    sessionId: ctx?.sessionId || null,
                  },
                  followupTarget: deriveScheduleFollowupTarget(ctx?.sessionId || null),
                })
                if (!prepared.ok) return prepared.error
                if (prepared.kind === 'duplicate') {
                  for (const [duplicateId, schedule] of prepared.entries) {
                    all[duplicateId] = schedule
                  }
                  if (prepared.entries.length > 0) res.save(all)
                  return JSON.stringify({
                    ...prepared.schedule,
                    deduplicated: true,
                  })
                }
                preparedManagedSchedule = prepared.schedule
              }
              if (toolKey === 'manage_tasks') {
                const prepared = prepareTaskCreation({
                  id: genId(),
                  input: parsed as Record<string, unknown>,
                  tasks: all as Record<string, BoardTask>,
                  now,
                  settings: loadSettings(),
                  fallbackAgentId: ctx?.agentId || null,
                  defaultCwd: cwd,
                  deriveTitleFromDescription: true,
                  requireMeaningfulTitle: true,
                  seed: parsed as Record<string, unknown>,
                })
                if (!prepared.ok) return prepared.error
                if (prepared.duplicate) {
                  return JSON.stringify({ ...prepared.duplicate, deduplicated: true })
                }
                preparedManagedTask = prepared.task
              }
              if (toolKey === 'manage_agents' && Object.prototype.hasOwnProperty.call(parsed, 'soul')) {
                const soulError = validateAgentSoulPayload((parsed as Record<string, unknown>).soul)
                if (soulError) return soulError
              }
              if (toolKey === 'manage_agents') {
                const duplicateAgent = findDuplicateManagedAgent(all as Record<string, unknown>, parsed as Record<string, unknown>, ctx)
                if (duplicateAgent) {
                  return JSON.stringify({ ...duplicateAgent, deduplicated: true })
                }
              }
              const newId = preparedManagedTask?.id || preparedManagedSchedule?.id || genId()
              const entry = toolKey === 'manage_tasks' && preparedManagedTask
                ? {
                    ...preparedManagedTask,
                    createdByAgentId: ctx?.agentId || null,
                    createdInSessionId: ctx?.sessionId || null,
                  }
                : toolKey === 'manage_schedules' && preparedManagedSchedule
                  ? preparedManagedSchedule
                  : {
                      id: newId,
                      ...parsed,
                      createdByAgentId: ctx?.agentId || null,
                      createdInSessionId: ctx?.sessionId || null,
                      createdAt: now,
                      updatedAt: now,
                    }
              let responseEntry: unknown = entry
              if (toolKey === 'manage_secrets') {
                const secretValue = typeof parsed.value === 'string' ? parsed.value : null
                if (!secretValue) return 'Error: data.value is required to create a secret.'
                const normalizedScope = parsed.scope === 'agent' ? 'agent' : 'global'
                const normalizedAgentIds = normalizedScope === 'agent'
                  ? dedup([
                      ...(Array.isArray(parsed.agentIds) ? parsed.agentIds.filter((x: unknown) => typeof x === 'string') as string[] : []),
                      ...(ctx?.agentId ? [ctx.agentId] : []),
                    ])
                  : []
                const stored = {
                  ...entry,
                  scope: normalizedScope,
                  agentIds: normalizedAgentIds,
                  projectId: typeof parsed.projectId === 'string' && parsed.projectId.trim() ? parsed.projectId.trim() : undefined,
                  encryptedValue: encryptKey(secretValue),
                }
                delete (stored as any).value
                all[newId] = stored
                const { encryptedValue, ...safe } = stored
                responseEntry = safe
              } else if (toolKey === 'manage_projects') {
                all[newId] = entry
                ensureProjectWorkspace(newId, entry.name)
                responseEntry = buildProjectSnapshot(entry)
              } else {
                all[newId] = entry
              }

              res.save(all)
              if (toolKey === 'manage_tasks') {
                const mission = ensureMissionForTask(entry as BoardTask, {
                  source: entry.sourceType === 'schedule'
                    ? 'schedule'
                    : entry.sourceType === 'delegation'
                      ? 'delegation'
                      : 'manual',
                })
                if (mission) {
                  responseEntry = enrichTaskWithMissionSummary({
                    ...(responseEntry as BoardTask),
                    missionId: mission.id,
                  })
                }
                if (taskDelegationAdvisory && responseEntry && typeof responseEntry === 'object') {
                  responseEntry = {
                    ...(responseEntry as Record<string, unknown>),
                    delegationAdvisory: taskDelegationAdvisory,
                  }
                }
              }
              if (toolKey === 'manage_tasks' && entry.status === 'queued') {
                const { enqueueTask } = await import('@/lib/server/runtime/queue')
                enqueueTask(newId)
              } else if (
                toolKey === 'manage_tasks'
                && (entry.status === 'completed' || entry.status === 'failed')
                && entry.sessionId
              ) {
                const { disableSessionHeartbeat } = await import('@/lib/server/runtime/queue')
                disableSessionHeartbeat(entry.sessionId)
              }
              return JSON.stringify(responseEntry)
            }
            if (action === 'update') {
              const effectiveId = id || (toolKey === 'manage_projects' ? ctx?.projectId || undefined : undefined)
              if (!effectiveId) return 'Error: "id" is required for update action.'
              const all = res.load()
              if (!all[effectiveId]) return `Not found: ${res.label} "${effectiveId}"`
              const previousEntry = all[effectiveId]
              let affectedScheduleIds: string[] | null = null
              const parsed = toolKey === 'manage_projects'
                ? normalizeProjectPatchInput(buildCrudPayload(normalized, action, data))
                : toolKey === 'manage_connectors'
                  ? sanitizeConnectorCrudPayload(buildCrudPayload(normalized, action, data), { forUpdate: true })
                : buildCrudPayload(normalized, action, data)
              const parsedRecord = parsed as Record<string, unknown>
              if (toolKey === 'manage_agents' && Object.prototype.hasOwnProperty.call(parsedRecord, 'soul')) {
                const soulError = validateAgentSoulPayload(parsedRecord.soul)
                if (soulError) return soulError
              }
              if (toolKey === 'manage_tasks') {
                const continuationError = applyTaskContinuationDefaults(parsedRecord, all as Record<string, BoardTask>, parsedRecord)
                if (continuationError) return continuationError
              }
              const prevStatus = all[effectiveId]?.status
              let taskDelegationAdvisory: Record<string, unknown> | null = null
              const managedAgents = toolKey === 'manage_tasks' || toolKey === 'manage_schedules'
                ? loadAgents()
                : null
              if (managedAgents) {
                const requestedClear = Object.prototype.hasOwnProperty.call(parsedRecord, 'agentId') && parsedRecord.agentId == null
                const shouldResolveAssignment = requestedClear
                  || hasManagedAgentAssignmentInput(parsedRecord)
                let resolvedAgentId: string | null = requestedClear
                  ? null
                  : (typeof all[effectiveId]?.agentId === 'string' ? all[effectiveId].agentId : null)
                let explicitAssignment = false
                if (shouldResolveAssignment) {
                  const resolution = resolveManagedAgentAssignment(
                    parsedRecord,
                    managedAgents,
                    null,
                    { allowDescription: false },
                  )
                  resolvedAgentId = requestedClear ? null : resolution.agentId
                  explicitAssignment = resolution.hadExplicitInput
                  const assignmentError = validateManagedAgentAssignment({
                    resourceLabel: res.label,
                    agents: managedAgents,
                    assignScope: canAssignOtherAgents ? 'all' : 'self',
                    currentAgentId: ctx?.agentId || null,
                    targetAgentId: resolvedAgentId,
                    unresolvedReference: requestedClear ? null : resolution.unresolvedReference,
                    isDelegation: toolKey === 'manage_tasks'
                      ? isDelegationTaskPayload({
                          ...all[effectiveId],
                          ...parsedRecord,
                          agentId: resolvedAgentId,
                        } as Record<string, unknown>)
                      : false,
                    delegatorAgentId: toolKey === 'manage_tasks'
                      ? resolveDelegatorAgentId({
                          ...all[effectiveId],
                          ...parsedRecord,
                        }, managedAgents, ctx?.agentId || null)
                      : null,
                  })
                  if (assignmentError) return assignmentError
                  if (!requestedClear) parsedRecord.agentId = resolvedAgentId
                }
                if (toolKey === 'manage_tasks') {
                  const delegated = await resolveManagedTaskDelegation({
                    parsed: {
                      ...all[effectiveId],
                      ...parsedRecord,
                    },
                    agents: managedAgents,
                    ctx,
                    assignedAgentId: resolvedAgentId,
                    explicitAssignment,
                    allowAutoAssignment: !resolvedAgentId || resolvedAgentId === ctx?.agentId,
                  })
                  if (delegated.assignedAgentId !== resolvedAgentId) {
                    parsedRecord.agentId = delegated.assignedAgentId
                  }
                  taskDelegationAdvisory = delegated.advisory
                }
              }
              if (toolKey === 'manage_schedules') {
                const prepared = prepareScheduleUpdate({
                  id: effectiveId,
                  current: all[effectiveId] as Record<string, unknown>,
                  patch: parsedRecord,
                  schedules: all as Record<string, ScheduleLike>,
                  now: Date.now(),
                  cwd,
                  agentExists: (agentId) => Boolean(managedAgents?.[agentId]),
                  propagateEquivalentStatuses: true,
                  propagationSource: previousEntry as Record<string, unknown>,
                })
                if (!prepared.ok) return prepared.error
                for (const [scheduleId, schedule] of prepared.entries) {
                  all[scheduleId] = schedule
                }
                affectedScheduleIds = prepared.affectedScheduleIds.length > 1 ? prepared.affectedScheduleIds : null
              } else if (toolKey === 'manage_tasks') {
                applyTaskPatch({
                  task: all[effectiveId] as BoardTask,
                  patch: parsedRecord,
                  now: Date.now(),
                  settings: loadSettings(),
                  preserveCompletedAt: true,
                })
              } else {
                all[effectiveId] = { ...all[effectiveId], ...parsed, updatedAt: Date.now() }
              }
              if (toolKey === 'manage_secrets') {
                if (!canAccessSecret(all[effectiveId])) return 'Error: you do not have access to this secret.'
                const nextScope = parsedRecord.scope === 'agent'
                  ? 'agent'
                  : parsedRecord.scope === 'global'
                    ? 'global'
                    : (all[effectiveId].scope === 'agent' ? 'agent' : 'global')
                if (nextScope === 'agent') {
                  const incomingIds = Array.isArray(parsedRecord.agentIds)
                    ? parsedRecord.agentIds.filter((x: any) => typeof x === 'string')
                    : Array.isArray(all[effectiveId].agentIds)
                      ? all[effectiveId].agentIds
                      : []
                  all[effectiveId].agentIds = dedup([
                    ...incomingIds,
                    ...(ctx?.agentId ? [ctx.agentId] : []),
                  ])
                } else {
                  all[effectiveId].agentIds = []
                }
                all[effectiveId].scope = nextScope
                if (Object.prototype.hasOwnProperty.call(parsedRecord, 'projectId')) {
                  all[effectiveId].projectId = typeof parsedRecord.projectId === 'string' && parsedRecord.projectId.trim()
                    ? parsedRecord.projectId.trim()
                    : undefined
                }
                if (typeof parsedRecord.value === 'string' && parsedRecord.value.trim()) {
                  all[effectiveId].encryptedValue = encryptKey(parsedRecord.value)
                }
                delete all[effectiveId].value
              }

              res.save(all)
              if (toolKey === 'manage_projects') {
                ensureProjectWorkspace(effectiveId, all[effectiveId].name)
              }
              if (toolKey === 'manage_tasks' && prevStatus !== 'queued' && all[effectiveId].status === 'queued') {
                const { enqueueTask } = await import('@/lib/server/runtime/queue')
                enqueueTask(effectiveId)
              } else if (
                toolKey === 'manage_tasks'
                && prevStatus !== all[effectiveId].status
                && (all[effectiveId].status === 'completed' || all[effectiveId].status === 'failed')
                && all[effectiveId].sessionId
              ) {
                const { disableSessionHeartbeat } = await import('@/lib/server/runtime/queue')
                disableSessionHeartbeat(all[effectiveId].sessionId)
              }
              if (toolKey === 'manage_secrets') {
                const { encryptedValue, ...safe } = all[effectiveId]
                return JSON.stringify(safe)
              }
              if (toolKey === 'manage_projects') {
                return JSON.stringify(buildProjectSnapshot(all[effectiveId]))
              }
              if (toolKey === 'manage_tasks' && taskDelegationAdvisory) {
                return JSON.stringify({
                  ...(all[effectiveId] as Record<string, unknown>),
                  delegationAdvisory: taskDelegationAdvisory,
                })
              }
              if (toolKey === 'manage_schedules' && affectedScheduleIds?.length) {
                return JSON.stringify({
                  ...all[effectiveId],
                  affectedScheduleIds,
                })
              }
              return JSON.stringify(all[effectiveId])
            }
            if (action === 'delete') {
              const effectiveId = id || (toolKey === 'manage_projects' ? ctx?.projectId || undefined : undefined)
              if (!effectiveId) return 'Error: "id" is required for delete action.'
              const all = res.load()
              if (!all[effectiveId]) return `Not found: ${res.label} "${effectiveId}"`
              if (toolKey === 'manage_secrets' && !canAccessSecret(all[effectiveId])) {
                return 'Error: you do not have access to this secret.'
              }
              if (toolKey === 'manage_schedules') {
                const archived = archiveScheduleCluster(effectiveId, {
                  actor: { actor: ctx?.agentId ? 'agent' : 'user', actorId: ctx?.agentId || undefined },
                })
                if (!archived.ok) return `Error: failed to archive schedule "${effectiveId}".`
                return JSON.stringify({
                  archived: effectiveId,
                  archivedIds: archived.archivedIds,
                  cancelledTaskIds: archived.cancelledTaskIds,
                  abortedRunSessionIds: archived.abortedRunSessionIds,
                })
              }
              const deletedIds = toolKey === 'manage_schedules'
                ? getScheduleClusterIds(all as Record<string, ScheduleLike>, all[effectiveId])
                : [effectiveId]
              for (const deleteId of deletedIds) {
                delete all[deleteId]
              }
              res.save(all)
              if (toolKey === 'manage_projects') {
                const clearProjectId = (load: () => Record<string, Record<string, unknown>>, save: (d: Record<string, Record<string, unknown>>) => void) => {
                  const items = load()
                  let changed = false
                  for (const item of Object.values(items)) {
                    if (item.projectId === effectiveId) {
                      item.projectId = undefined
                      changed = true
                    }
                  }
                  if (changed) save(items)
                }
                clearProjectId(
                  loadAgents as unknown as () => Record<string, Record<string, unknown>>,
                  saveAgents as unknown as (data: Record<string, Record<string, unknown>>) => void,
                )
                clearProjectId(
                  loadTasks as unknown as () => Record<string, Record<string, unknown>>,
                  saveTasks as unknown as (data: Record<string, Record<string, unknown>>) => void,
                )
                clearProjectId(
                  loadSchedules as unknown as () => Record<string, Record<string, unknown>>,
                  saveSchedules as unknown as (data: Record<string, Record<string, unknown>>) => void,
                )
                clearProjectId(
                  loadSkills as unknown as () => Record<string, Record<string, unknown>>,
                  saveSkills as unknown as (data: Record<string, Record<string, unknown>>) => void,
                )
                clearProjectId(
                  loadSecrets as unknown as () => Record<string, Record<string, unknown>>,
                  saveSecrets as unknown as (data: Record<string, Record<string, unknown>>) => void,
                )
              }
              return JSON.stringify({
                deleted: effectiveId,
                deletedIds,
              })
            }
            // ── Credential self-service: check + request ──
            if (action === 'check' && toolKey === 'manage_secrets') {
              const service = typeof normalized.service === 'string' ? normalized.service.trim().toLowerCase() : ''
              if (!service) return 'Error: "service" is required for check action.'
              const template = findCredentialTemplate(service)
              const all = res.load()
              const match = Object.values(all).find(
                (s: any) => canAccessSecret(s) && typeof s.service === 'string' && s.service.toLowerCase() === service,
              ) as Record<string, unknown> | undefined
              const result: Record<string, unknown> = {
                found: !!match,
                service,
                template: template
                  ? { serviceId: template.serviceId, name: template.name, category: template.category, keyUrl: template.keyUrl, signupUrl: template.signupUrl, canSelfProvision: template.canSelfProvision ?? false, fields: template.fields.map((f) => ({ key: f.key, label: f.label, required: f.required !== false })) }
                  : null,
              }
              if (match) {
                result.secretId = match.id
                result.secretName = match.name
                // Optionally validate the credential
                if (normalized.validate === true && template?.validationEndpoint) {
                  try {
                    const value = match.encryptedValue ? decryptKey(match.encryptedValue as string) : ''
                    if (value) {
                      const headers: Record<string, string> = {}
                      if (template.validationMethod === 'header_auth') {
                        headers['Authorization'] = `Bearer ${value}`
                      }
                      const controller = new AbortController()
                      const timeout = setTimeout(() => controller.abort(), 5000)
                      try {
                        const resp = await fetch(template.validationEndpoint, {
                          method: 'GET',
                          headers,
                          signal: controller.signal,
                          ...(template.validationMethod === 'basic_auth'
                            ? { headers: { 'Authorization': `Basic ${Buffer.from(`${value}:`).toString('base64')}` } }
                            : {}),
                        })
                        clearTimeout(timeout)
                        result.valid = resp.ok
                        result.validationStatus = resp.status
                      } catch {
                        clearTimeout(timeout)
                        result.valid = false
                        result.validationError = 'Request failed or timed out'
                      }
                    } else {
                      result.valid = false
                      result.validationError = 'Empty credential value'
                    }
                  } catch {
                    result.valid = false
                    result.validationError = 'Failed to decrypt credential'
                  }
                }
              }
              return JSON.stringify(result)
            }
            if (action === 'request' && toolKey === 'manage_secrets') {
              const service = typeof normalized.service === 'string' ? normalized.service.trim().toLowerCase() : ''
              if (!service) return 'Error: "service" is required for request action.'
              const reason = typeof normalized.reason === 'string' ? normalized.reason.trim() : ''
              const template = findCredentialTemplate(service)

              // Check if credential already exists
              const all = res.load()
              const existing = Object.values(all).find(
                (s: any) => canAccessSecret(s) && typeof s.service === 'string' && s.service.toLowerCase() === service,
              ) as Record<string, unknown> | undefined
              if (existing) {
                return JSON.stringify({
                  status: 'already_exists',
                  secretId: existing.id,
                  secretName: existing.name,
                  service,
                  message: `A credential for "${template?.name || service}" already exists. Use action="get" with id="${existing.id}" to retrieve it.`,
                })
              }

              // Build the request message for the human
              const requestMessage = template
                ? buildCredentialRequestMessage(template, reason)
                : [
                    `**Credential needed: ${service}**`,
                    reason ? `\nReason: ${reason}` : '',
                    '\nPlease provide the required credentials for this service.',
                  ].filter(Boolean).join('\n')

              const sessionId = ctx?.sessionId
              if (!sessionId) return 'Error: no active session to send credential request.'

              // Register a durable wait so the agent pauses until the human provides the credential
              const correlationId = `cred-request:${service}:${genId().slice(0, 8)}`
              const job = await createWatchJob({
                type: 'mailbox',
                sessionId,
                agentId: ctx?.agentId || null,
                createdByAgentId: ctx?.agentId || null,
                description: `Waiting for ${template?.name || service} credential`,
                resumeMessage: `The human replied with credential information for ${template?.name || service}. Read the reply, then store the provided value as a secret using manage_secrets(action="create", service="${service}", name="${template?.name || service} API Key", value="<the value from the reply>").`,
                timeoutAt: Date.now() + 24 * 3600_000, // 24h timeout
                target: { sessionId },
                condition: {
                  type: 'human_reply',
                  correlationId,
                },
              })

              return JSON.stringify({
                status: 'credential_requested',
                service,
                template: template ? { name: template.name, keyUrl: template.keyUrl, signupUrl: template.signupUrl } : null,
                correlationId,
                watchJobId: job.id,
                requestMessage,
                message: `Credential request posted. Stop active tool use now and wait for the human to provide the ${template?.name || service} credential. The request includes instructions on where to obtain the key.`,
              })
            }
            if (action === 'claim_task' && toolKey === 'manage_tasks') {
              if (!id) return 'Error: "id" is required for claim_task action.'
              const { claimPoolTask } = await import('@/lib/server/runtime/queue')
              const result = claimPoolTask(id, ctx?.agentId || '')
              if (!result.success) return `Error: ${result.error}`
              return JSON.stringify({ ok: true, taskId: id, claimedByAgentId: ctx?.agentId })
            }
            return `Unknown action "${action}". Valid: list, get, create, update, delete, claim_task`
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: toolKey,
          description,
          schema: toolKey === 'manage_skills'
            ? z.object({
                action: z.enum([
                  'list',
                  'get',
                  'create',
                  'update',
                  'delete',
                  'status',
                  'search_available',
                  'recommend_for_task',
                  'attach',
                  'install',
                ]).describe('The manage_skills action to perform'),
                id: z.string().optional().describe('Stored skill ID or runtime skill selector'),
                skillId: z.string().optional().describe('Alternate skill selector'),
                name: z.string().optional().describe('Skill name or marketplace name'),
                query: z.string().optional().describe('Search query or task description'),
                task: z.string().optional().describe('Task description for skill recommendation'),
                url: z.string().optional().describe('Remote skill URL for install'),
                approvalId: z.string().optional().describe('Approved install request id'),
                attach: z.boolean().optional().describe('Attach the skill to the current agent after install'),
                agentId: z.string().optional().describe('Target agent id for attach'),
                data: z.string().optional().describe('JSON string of fields for create/update'),
              }).passthrough()
            : z.object({
                action: z.enum(['list', 'get', 'create', 'update', 'delete', 'claim_task', 'check', 'request']).describe('The CRUD action to perform'),
                id: z.string().optional().describe('Resource ID (required for get, update, delete)'),
                data: z.string().optional().describe('JSON string of fields for create/update'),
              }).passthrough(),
        },
      ),
    )
  }

  return tools
}
