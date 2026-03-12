import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import { genId } from '@/lib/id'
import { spawnSync } from 'child_process'
import * as cheerio from 'cheerio'
import {
  loadAgents, saveAgents,
  loadProjects, saveProjects,
  loadTasks, saveTasks,
  loadSchedules, saveSchedules,
  loadSkills, saveSkills,
  loadConnectors, saveConnectors,
  loadDocuments, saveDocuments,
  loadWebhooks, saveWebhooks,
  loadSecrets, saveSecrets,
  loadSessions, saveSessions,
  loadSettings,
  encryptKey,
  decryptKey,
} from '../storage'
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
import {
  applyTaskContinuationDefaults,
  applyTaskPatch,
  deriveTaskTitle,
  prepareTaskCreation,
} from '@/lib/server/tasks/task-service'
import type { ToolBuildContext } from './context'
import { safePath, findBinaryOnPath } from './context'
import { normalizeToolInputArgs } from './normalize-tool-args'
import type { BoardTask } from '@/types'
import { dedup } from '@/lib/shared-utils'
import { isDirectConnectorSession } from '../connectors/session-kind'
import { buildManageSkillsDescription, executeManageSkillsAction } from './skills'

// ---------------------------------------------------------------------------
// Document helpers
// ---------------------------------------------------------------------------

const MAX_DOCUMENT_TEXT_CHARS = 500_000

function extractDocumentText(filePath: string): { text: string; method: string } {
  const ext = path.extname(filePath).toLowerCase()

  const readUtf8Text = (): string => {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const cleaned = raw.replace(/\u0000/g, '')
    return cleaned
  }

  if (ext === '.pdf') {
    const pdftotextBinary = findBinaryOnPath('pdftotext')
    if (!pdftotextBinary) throw new Error('pdftotext is not installed. Install poppler to index PDF files.')
    const out = spawnSync(pdftotextBinary, ['-layout', '-nopgbrk', '-q', filePath, '-'], {
      encoding: 'utf-8',
      maxBuffer: 25 * 1024 * 1024,
      timeout: 20_000,
    })
    if ((out.status ?? 1) !== 0) {
      throw new Error(`pdftotext failed: ${(out.stderr || out.stdout || '').trim() || 'unknown error'}`)
    }
    return { text: out.stdout || '', method: 'pdftotext' }
  }

  if (['.txt', '.md', '.markdown', '.json', '.csv', '', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.yaml', '.yml'].includes(ext)) {
    return { text: readUtf8Text(), method: 'utf8' }
  }

  if (ext === '.html' || ext === '.htm') {
    const html = fs.readFileSync(filePath, 'utf-8')
    const $ = cheerio.load(html)
    const text = $('body').text() || $.text()
    return { text, method: 'html-strip' }
  }

  if (['.doc', '.docx', '.rtf'].includes(ext)) {
    const out = spawnSync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', filePath], {
      encoding: 'utf-8',
      maxBuffer: 25 * 1024 * 1024,
      timeout: 20_000,
    })
    if ((out.status ?? 1) === 0 && out.stdout?.trim()) {
      return { text: out.stdout, method: 'textutil' }
    }
  }

  const fallback = readUtf8Text()
  if (fallback.trim()) return { text: fallback, method: 'utf8-fallback' }
  throw new Error(`Unsupported document type: ${ext || '(no extension)'}`)
}

function trimDocumentContent(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim()
  if (normalized.length <= MAX_DOCUMENT_TEXT_CHARS) return normalized
  return normalized.slice(0, MAX_DOCUMENT_TEXT_CHARS)
}

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

  const session = loadSessions()[normalizedSessionId] as {
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

  const messages = Array.isArray(session.messages) ? session.messages : []
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
    platformAssignScope: p.platformAssignScope === 'all' ? 'all' : 'self',
    isOrchestrator: p.platformAssignScope === 'all',
    tools: p.tools || [],
    skills: p.skills || [],
    skillIds: p.skillIds || [],
    subAgentIds: p.subAgentIds || [],
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
  manage_sessions: { toolId: 'manage_sessions', label: 'sessions', load: loadSessions, save: saveSessions, readOnly: true },
  manage_secrets: { toolId: 'manage_secrets', label: 'secrets', load: loadSecrets, save: saveSecrets },
}

// ---------------------------------------------------------------------------
// buildCrudTools
// ---------------------------------------------------------------------------

export function buildCrudTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { cwd, ctx, hasPlugin } = bctx
  const buildCrudPayload = (normalized: Record<string, unknown>, action: string | undefined, data: string | undefined): Record<string, unknown> => {
    if (data) return JSON.parse(data)
    if (action !== 'create' && action !== 'update') return {}
    const entries = Object.entries(normalized).filter(([key]) =>
      !['action', 'id', 'data', 'resource', 'input', 'args', 'arguments', 'payload', 'parameters'].includes(key),
    )
    return entries.length > 0 ? Object.fromEntries(entries) : {}
  }

  // Build dynamic agent summary for tools that need agent awareness
  const assignScope = ctx?.platformAssignScope || 'self'
  let agentSummary = ''
  if (hasPlugin('manage_tasks') || hasPlugin('manage_schedules')) {
    if (assignScope === 'all') {
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
    if (!hasPlugin(toolKey)) continue

    let description = `Manage SwarmClaw ${res.label}. ${res.readOnly ? 'List and get only.' : 'List, get, create, update, or delete.'} Returns JSON.`
    if (toolKey.startsWith('manage_') && toolKey !== 'manage_platform') {
      description += `\n\nUse this direct tool name exactly as shown (\`${toolKey}\`). Do not swap it for \`manage_platform\` unless that umbrella tool is separately enabled in the current session.`
    }
    if (toolKey === 'manage_tasks') {
      if (assignScope === 'self') {
        description += `\n\nYou may create tasks for yourself ("${ctx?.agentId || 'unknown'}") or leave them unassigned to track multi-step work. You cannot assign tasks to other agents unless a user enables "Assign to Other Agents" in your agent settings. Valid manual statuses: backlog, queued, completed, failed, archived. "running" is runtime-only and set automatically when execution starts.`
      } else {
        description += `\n\nYou may create tasks for yourself, leave them unassigned, or delegate them to other agents. Your agent ID is "${ctx?.agentId || 'unknown'}". When delegating, set a target agent using "agentId", "assignee", "agent", "assignedAgentId", or "assigned_agent_id". Use the target agent's exact ID when possible. Valid manual statuses: backlog, queued, completed, failed, archived. "running" is runtime-only and set automatically when execution starts.` + agentSummary
      }
      description += '\n\nCreate/update calls accept either `data` as a JSON string or direct top-level fields like `title`, `description`, `status`, `agentId`, and `projectId`.'
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
      description += `\n\nAgents may self-edit their own soul only when explicitly changing persona or operating instructions. Do not use manage_agents to store user preferences, durable facts, or normal memory; use the memory tools for that. To update your soul, use action="update", id="${ctx?.agentId || 'your-agent-id'}", and include data with the "soul" field. Set "platformAssignScope":"all" to let an agent delegate work across the fleet; use "self" for solo execution.`
    } else if (toolKey === 'manage_schedules') {
      if (assignScope === 'self') {
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
                  assignScope,
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
              const managedAgents = toolKey === 'manage_tasks' || toolKey === 'manage_schedules'
                ? loadAgents()
                : null
              if (managedAgents) {
                const requestedClear = Object.prototype.hasOwnProperty.call(parsedRecord, 'agentId') && parsedRecord.agentId == null
                const shouldResolveAssignment = requestedClear
                  || hasManagedAgentAssignmentInput(parsedRecord)
                if (shouldResolveAssignment) {
                  const resolution = resolveManagedAgentAssignment(
                    parsedRecord,
                    managedAgents,
                    null,
                    { allowDescription: false },
                  )
                  const assignmentError = validateManagedAgentAssignment({
                    resourceLabel: res.label,
                    agents: managedAgents,
                    assignScope,
                    currentAgentId: ctx?.agentId || null,
                    targetAgentId: requestedClear ? null : resolution.agentId,
                    unresolvedReference: requestedClear ? null : resolution.unresolvedReference,
                    isDelegation: toolKey === 'manage_tasks'
                      ? isDelegationTaskPayload({
                          ...all[effectiveId],
                          ...parsedRecord,
                          agentId: requestedClear ? null : resolution.agentId,
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
                  if (!requestedClear) parsedRecord.agentId = resolution.agentId
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
                clearProjectId(loadAgents, saveAgents)
                clearProjectId(loadTasks, saveTasks as any)
                clearProjectId(loadSchedules, saveSchedules as any)
                clearProjectId(loadSkills, saveSkills as any)
                clearProjectId(loadSecrets, saveSecrets as any)
              }
              return JSON.stringify({
                deleted: effectiveId,
                deletedIds,
              })
            }
            return `Unknown action "${action}". Valid: list, get, create, update, delete`
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
                action: z.enum(['list', 'get', 'create', 'update', 'delete']).describe('The CRUD action to perform'),
                id: z.string().optional().describe('Resource ID (required for get, update, delete)'),
                data: z.string().optional().describe('JSON string of fields for create/update'),
              }).passthrough(),
        },
      ),
    )
  }

  if (hasPlugin('manage_documents')) {
    tools.push(
      tool(
        async (rawArgs) => {
          const normalized = normalizeToolInputArgs((rawArgs ?? {}) as Record<string, unknown>)
          const action = normalized.action as string | undefined
          const id = normalized.id as string | undefined
          const filePath = (normalized.filePath ?? normalized.path) as string | undefined
          const query = normalized.query as string | undefined
          const limit = normalized.limit as number | undefined
          const metadata = normalized.metadata as string | undefined
          const title = normalized.title as string | undefined
          try {
            const documents = loadDocuments()

            if (action === 'list') {
              const rows = Object.values(documents)
                .sort((a: any, b: any) => (b.updatedAt || 0) - (a.updatedAt || 0))
                .slice(0, Math.max(1, Math.min(limit || 100, 500)))
                .map((doc: any) => ({
                  id: doc.id,
                  title: doc.title,
                  fileName: doc.fileName,
                  sourcePath: doc.sourcePath,
                  textLength: doc.textLength,
                  method: doc.method,
                  metadata: doc.metadata || {},
                  createdAt: doc.createdAt,
                  updatedAt: doc.updatedAt,
                }))
              return JSON.stringify(rows)
            }

            if (action === 'get') {
              if (!id) return 'Error: id is required for get.'
              const doc = documents[id]
              if (!doc) return `Not found: document "${id}"`
              const maxContentChars = 60_000
              return JSON.stringify({
                ...doc,
                content: typeof doc.content === 'string' && doc.content.length > maxContentChars
                  ? `${doc.content.slice(0, maxContentChars)}\n... [truncated]`
                  : (doc.content || ''),
              })
            }

            if (action === 'delete') {
              if (!id) return 'Error: id is required for delete.'
              if (!documents[id]) return `Not found: document "${id}"`
              delete documents[id]
              saveDocuments(documents)
              return JSON.stringify({ ok: true, id })
            }

            if (action === 'upload') {
              if (!filePath?.trim()) return 'Error: filePath is required for upload.'
              const sourcePath = path.isAbsolute(filePath) ? filePath : safePath(cwd, filePath, bctx.filesystemScope)
              if (!fs.existsSync(sourcePath)) return `Error: file not found: ${filePath}`
              const stat = fs.statSync(sourcePath)
              if (!stat.isFile()) return 'Error: upload expects a file path.'

              const extracted = extractDocumentText(sourcePath)
              const content = trimDocumentContent(extracted.text)
              if (!content) return 'Error: extracted document text is empty.'

              const docId = genId(6)
              const now = Date.now()
              const parsedMetadata = metadata && typeof metadata === 'string'
                ? (() => {
                    try {
                      const m = JSON.parse(metadata)
                      return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {}
                    } catch {
                      return {}
                    }
                  })()
                : {}

              const entry = {
                id: docId,
                title: title?.trim() || path.basename(sourcePath),
                fileName: path.basename(sourcePath),
                sourcePath,
                method: extracted.method,
                textLength: content.length,
                content,
                metadata: parsedMetadata,
                uploadedByAgentId: ctx?.agentId || null,
                uploadedInSessionId: ctx?.sessionId || null,
                createdAt: now,
                updatedAt: now,
              }
              documents[docId] = entry
              saveDocuments(documents)
              return JSON.stringify({
                id: entry.id,
                title: entry.title,
                fileName: entry.fileName,
                textLength: entry.textLength,
                method: entry.method,
              })
            }

            if (action === 'search') {
              const q = (query || '').trim().toLowerCase()
              if (!q) return 'Error: query is required for search.'
              const terms = q.split(/\s+/).filter(Boolean)
              const max = Math.max(1, Math.min(limit || 5, 50))

              const matches = Object.values(documents)
                .map((doc: any) => {
                  const hay = (doc.content || '').toLowerCase()
                  if (!hay) return null
                  if (!terms.every((term) => hay.includes(term))) return null
                  let score = hay.includes(q) ? 10 : 0
                  for (const term of terms) {
                    let pos = hay.indexOf(term)
                    while (pos !== -1) {
                      score += 1
                      pos = hay.indexOf(term, pos + term.length)
                    }
                  }
                  const firstTerm = terms[0] || q
                  const at = firstTerm ? hay.indexOf(firstTerm) : -1
                  const start = at >= 0 ? Math.max(0, at - 120) : 0
                  const end = Math.min((doc.content || '').length, start + 320)
                  const snippet = ((doc.content || '').slice(start, end) || '').replace(/\s+/g, ' ').trim()
                  return {
                    id: doc.id,
                    title: doc.title,
                    score,
                    snippet,
                    textLength: doc.textLength,
                    updatedAt: doc.updatedAt,
                  }
                })
                .filter(Boolean)
                .sort((a: any, b: any) => b.score - a.score)
                .slice(0, max)

              return JSON.stringify({
                query,
                total: matches.length,
                matches,
              })
            }

            return 'Unknown action. Use list, upload, search, get, or delete.'
          } catch (err: any) {
            return `Error: ${err.message || String(err)}`
          }
        },
        {
          name: 'manage_documents',
          description: 'Upload and index documents, then search/get/delete them for long-term retrieval. Supports PDFs (via pdftotext) and common text/doc formats.',
          schema: z.object({
            action: z.enum(['list', 'upload', 'search', 'get', 'delete']).describe('Document action'),
            id: z.string().optional().describe('Document id (for get/delete)'),
            filePath: z.string().optional().describe('Path to document file for upload (relative to working directory or absolute)'),
            title: z.string().optional().describe('Optional title override for upload'),
            query: z.string().optional().describe('Search query text (for search)'),
            limit: z.number().optional().describe('Max results (default 5 for search, 100 for list)'),
            metadata: z.string().optional().describe('Optional JSON string metadata for upload'),
          }),
        },
      ),
    )
  }

  return tools
}
