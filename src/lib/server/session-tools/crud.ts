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
import { resolveScheduleName } from '@/lib/schedule-name'
import { findDuplicateSchedule, type ScheduleLike } from '@/lib/schedule-dedupe'
import { computeTaskFingerprint, findDuplicateTask } from '@/lib/task-dedupe'
import {
  hasManagedAgentAssignmentInput,
  isDelegationTaskPayload,
  resolveDelegatorAgentId,
  resolveManagedAgentAssignment,
  validateManagedAgentAssignment,
} from '@/lib/server/agent-assignment'
import { normalizeTaskQualityGate } from '@/lib/server/task-quality-gate'
import { normalizeSchedulePayload } from '@/lib/server/schedule-normalization'
import { buildProjectSnapshot, ensureProjectWorkspace, normalizeProjectCreateInput, normalizeProjectPatchInput } from '@/lib/server/project-utils'
import type { ToolBuildContext } from './context'
import { safePath, findBinaryOnPath } from './context'
import { normalizeToolInputArgs } from './normalize-tool-args'
import type { BoardTask } from '@/types'

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

  if (['.txt', '.md', '.markdown', '.json', '.csv', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.yaml', '.yml'].includes(ext)) {
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

function deriveTaskTitle(input: { title?: unknown; description?: unknown }): string {
  const explicit = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : ''
  if (explicit && !/^untitled task$/i.test(explicit)) return explicit.slice(0, 120)

  const description = typeof input.description === 'string'
    ? input.description.replace(/\s+/g, ' ').trim()
    : ''
  if (!description) return ''

  const firstSentence = description.split(/[.!?]\s+/)[0] || description
  const compact = firstSentence
    .replace(/^please\s+/i, '')
    .replace(/^(create|make|build|implement|write)\s+/i, '')
    .trim()
  if (!compact) return ''
  return compact.slice(0, 120)
}

const TASK_STATUS_VALUES = new Set([
  'backlog',
  'queued',
  'running',
  'completed',
  'failed',
  'archived',
])

function normalizeTaskStatusInput(status: unknown, prevStatus?: string): string | null {
  if (typeof status !== 'string') return null
  const normalized = status.trim().toLowerCase()
  if (!TASK_STATUS_VALUES.has(normalized)) return null
  if (normalized === 'running' && prevStatus !== 'running') return 'queued'
  return normalized
}

function normalizeTaskIdList(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of rawValues) {
    const normalized = typeof entry === 'string' ? entry.trim() : ''
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

function pickFirstTaskId(value: unknown): string | null {
  const ids = normalizeTaskIdList(value)
  return ids[0] || null
}

function applyTaskContinuationDefaults(
  parsed: Record<string, unknown>,
  tasks: Record<string, BoardTask>,
  explicitInput?: Record<string, unknown>,
): string | null {
  const explicit = explicitInput || parsed
  const continuationTaskId = pickFirstTaskId(parsed.continueFromTaskId)
    || pickFirstTaskId(parsed.followUpToTaskId)
    || pickFirstTaskId(parsed.resumeFromTaskId)
  const blockedBy = [
    ...normalizeTaskIdList(parsed.blockedBy),
    ...normalizeTaskIdList(parsed.dependsOn),
    ...normalizeTaskIdList(parsed.dependsOnTaskIds),
    ...normalizeTaskIdList(parsed.prerequisiteTaskIds),
  ]
  if (continuationTaskId && !blockedBy.includes(continuationTaskId)) {
    blockedBy.unshift(continuationTaskId)
  }
  if (blockedBy.length > 0) parsed.blockedBy = blockedBy

  if (continuationTaskId) {
    const sourceTask = tasks[continuationTaskId]
    if (!sourceTask) return `Error: source task "${continuationTaskId}" not found.`

    if (!Object.prototype.hasOwnProperty.call(explicit, 'projectId') && typeof sourceTask.projectId === 'string' && sourceTask.projectId.trim()) {
      parsed.projectId = sourceTask.projectId.trim()
    }
    if (
      !Object.prototype.hasOwnProperty.call(explicit, 'agentId')
      && !hasManagedAgentAssignmentInput(explicit)
      && typeof sourceTask.agentId === 'string'
      && sourceTask.agentId.trim()
    ) {
      parsed.agentId = sourceTask.agentId.trim()
    }
    if (!Object.prototype.hasOwnProperty.call(explicit, 'cwd') && typeof sourceTask.cwd === 'string' && sourceTask.cwd.trim()) {
      parsed.cwd = sourceTask.cwd.trim()
    }
    const sourceSessionId = typeof sourceTask.checkpoint?.lastSessionId === 'string' && sourceTask.checkpoint.lastSessionId.trim()
      ? sourceTask.checkpoint.lastSessionId.trim()
      : typeof sourceTask.sessionId === 'string' && sourceTask.sessionId.trim()
        ? sourceTask.sessionId.trim()
        : ''
    if (!Object.prototype.hasOwnProperty.call(explicit, 'sessionId') && sourceSessionId) {
      parsed.sessionId = sourceSessionId
    }

    const resumeFieldMap: Array<[keyof BoardTask, string]> = [
      ['cliResumeId', 'cliResumeId'],
      ['cliProvider', 'cliProvider'],
      ['claudeResumeId', 'claudeResumeId'],
      ['codexResumeId', 'codexResumeId'],
      ['opencodeResumeId', 'opencodeResumeId'],
      ['geminiResumeId', 'geminiResumeId'],
    ]
    for (const [sourceKey, targetKey] of resumeFieldMap) {
      const value = sourceTask[sourceKey]
      if (Object.prototype.hasOwnProperty.call(explicit, targetKey)) continue
      if (typeof value === 'string' && value.trim()) {
        parsed[targetKey] = value.trim()
      }
    }
  }

  for (const aliasKey of ['continueFromTaskId', 'followUpToTaskId', 'resumeFromTaskId', 'dependsOn', 'dependsOnTaskIds', 'prerequisiteTaskIds']) {
    delete parsed[aliasKey]
  }
  return null
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
    name: p.name || 'Unnamed Connector',
    platform: p.platform || 'discord',
    agentId: p.agentId || null,
    enabled: p.enabled ?? false,
    ...p,
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
      description += `\n\nAgents may self-edit their own soul. To update your soul, use action="update", id="${ctx?.agentId || 'your-agent-id'}", and include data with the "soul" field. Set "platformAssignScope":"all" to let an agent delegate work across the fleet; use "self" for solo execution.`
    } else if (toolKey === 'manage_schedules') {
      if (assignScope === 'self') {
        description += `\n\nOmit "agentId" to assign a schedule to yourself ("${ctx?.agentId || 'unknown'}"), or set it explicitly to yourself. You can only assign schedules to yourself. Schedule types: interval (set intervalMs), cron (set cron), once (set runAt). Provide either taskPrompt, command, or action+path. Before create, call list/get to avoid duplicate schedules. If an equivalent active/paused schedule already exists, create returns that existing schedule (deduplicated=true).`
      } else {
        description += `\n\nOmit "agentId" to assign a schedule to yourself ("${ctx?.agentId || 'unknown'}"), or set "agentId" to another agent when needed. Schedule types: interval (set intervalMs), cron (set cron), once (set runAt). Provide either taskPrompt, command, or action+path. Before create, call list/get to avoid duplicate schedules. If an equivalent active/paused schedule already exists, create returns that existing schedule (deduplicated=true).` + agentSummary
      }
      if (ctx?.projectId) {
        description += `\n\nCurrent project context: "${ctx.projectName || ctx.projectId}" (projectId "${ctx.projectId}"). Omit "projectId" to use this active project by default.`
      }
    } else if (toolKey === 'manage_webhooks') {
      description += '\n\nUse `source`, `events`, `agentId`, and `secret` when creating webhooks. Inbound calls should POST to `/api/webhooks/{id}` with header `x-webhook-secret` when a secret is configured.'
    } else if (toolKey === 'manage_secrets') {
      description += '\n\nUse this for credential bootstrapping and durable secret storage. Create/update calls accept either `data` as JSON or direct top-level fields like `name`, `service`, `value`, `scope`, `agentIds`, and `projectId`.'
      if (ctx?.projectId) {
        description += `\n\nCurrent project context: "${ctx.projectName || ctx.projectId}" (projectId "${ctx.projectId}"). Omit "projectId" to link the secret to this active project.`
      }
    }

    tools.push(
      tool(
        async (rawArgs) => {
          const normalized = normalizeToolInputArgs((rawArgs ?? {}) as Record<string, unknown>)
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
              if (toolKey === 'manage_schedules') {
                const normalizedSchedule = normalizeSchedulePayload(parsed as Record<string, unknown>, {
                  cwd,
                  now,
                })
                if (!normalizedSchedule.ok) return normalizedSchedule.error
                Object.assign(parsed, normalizedSchedule.value)
                const duplicate = findDuplicateSchedule(all as Record<string, ScheduleLike>, {
                  agentId: parsed.agentId || null,
                  taskPrompt: parsed.taskPrompt || '',
                  scheduleType: parsed.scheduleType || 'interval',
                  cron: parsed.cron,
                  intervalMs: parsed.intervalMs,
                  runAt: parsed.runAt,
                  createdByAgentId: ctx?.agentId || null,
                  createdInSessionId: ctx?.sessionId || null,
                }, {
                  creatorScope: {
                    agentId: ctx?.agentId || null,
                    sessionId: ctx?.sessionId || null,
                  },
                })
                if (duplicate) {
                  let changed = false
                  const duplicateId = typeof duplicate.id === 'string' ? duplicate.id : ''
                  const nextName = resolveScheduleName({
                    name: parsed.name ?? duplicate.name,
                    taskPrompt: parsed.taskPrompt ?? duplicate.taskPrompt,
                  })
                  if (nextName && nextName !== duplicate.name) {
                    duplicate.name = nextName
                    changed = true
                  }
                  const normalizedStatus = typeof parsed.status === 'string' ? parsed.status.trim().toLowerCase() : ''
                  if ((normalizedStatus === 'active' || normalizedStatus === 'paused') && duplicate.status !== normalizedStatus) {
                    duplicate.status = normalizedStatus
                    changed = true
                  }
                  if (changed) {
                    duplicate.updatedAt = now
                    if (duplicateId) all[duplicateId] = duplicate
                    res.save(all)
                  }
                  return JSON.stringify({
                    ...duplicate,
                    deduplicated: true,
                  })
                }
              }
              if (toolKey === 'manage_tasks') {
                parsed.title = deriveTaskTitle(parsed)
                if (!parsed.title || /^untitled task$/i.test(parsed.title)) {
                  return 'Error: manage_tasks create requires a specific title or a meaningful description.'
                }
                parsed.status = normalizeTaskStatusInput(parsed.status) || 'backlog'
                if (!parsed.cwd && cwd) parsed.cwd = cwd
                if (Object.prototype.hasOwnProperty.call(parsed, 'qualityGate')) {
                  const settings = loadSettings()
                  parsed.qualityGate = parsed.qualityGate
                    ? normalizeTaskQualityGate(parsed.qualityGate, settings)
                    : null
                }
              }
              // Task dedup
              if (toolKey === 'manage_tasks') {
                const fp = computeTaskFingerprint(parsed.title || 'Untitled Task', parsed.agentId || ctx?.agentId || '')
                parsed.fingerprint = fp
                const dupe = findDuplicateTask(all as Record<string, import('@/types').BoardTask>, { fingerprint: fp })
                if (dupe) {
                  return JSON.stringify({ ...dupe, deduplicated: true })
                }
              }
              const newId = genId()
              const entry = {
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
                  ? Array.from(new Set([
                      ...(Array.isArray(parsed.agentIds) ? parsed.agentIds.filter((x: any) => typeof x === 'string') : []),
                      ...(ctx?.agentId ? [ctx.agentId] : []),
                    ]))
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

              if (toolKey === 'manage_tasks' && entry.status === 'completed') {
                const { formatValidationFailure, validateTaskCompletion } = await import('../task-validation')
                const { ensureTaskCompletionReport } = await import('../task-reports')
                const settings = loadSettings()
                const report = ensureTaskCompletionReport(entry as any)
                if (report?.relativePath) (entry as any).completionReportPath = report.relativePath
                const validation = validateTaskCompletion(entry as any, { report, settings })
                ;(entry as any).validation = validation
                if (!validation.ok) {
                  entry.status = 'failed'
                  ;(entry as any).completedAt = null
                  ;(entry as any).error = formatValidationFailure(validation.reasons).slice(0, 500)
                }
              }

              res.save(all)
              if (toolKey === 'manage_tasks' && entry.status === 'queued') {
                const { enqueueTask } = await import('../queue')
                enqueueTask(newId)
              } else if (
                toolKey === 'manage_tasks'
                && (entry.status === 'completed' || entry.status === 'failed')
                && entry.sessionId
              ) {
                const { disableSessionHeartbeat } = await import('../queue')
                disableSessionHeartbeat(entry.sessionId)
              }
              return JSON.stringify(responseEntry)
            }
            if (action === 'update') {
              const effectiveId = id || (toolKey === 'manage_projects' ? ctx?.projectId || undefined : undefined)
              if (!effectiveId) return 'Error: "id" is required for update action.'
              const all = res.load()
              if (!all[effectiveId]) return `Not found: ${res.label} "${effectiveId}"`
              const parsed = toolKey === 'manage_projects'
                ? normalizeProjectPatchInput(buildCrudPayload(normalized, action, data))
                : buildCrudPayload(normalized, action, data)
              const parsedRecord = parsed as Record<string, unknown>
              if (toolKey === 'manage_tasks') {
                const continuationError = applyTaskContinuationDefaults(parsedRecord, all as Record<string, BoardTask>, parsedRecord)
                if (continuationError) return continuationError
              }
              const prevStatus = all[effectiveId]?.status
              if (toolKey === 'manage_tasks' && Object.prototype.hasOwnProperty.call(parsedRecord, 'status')) {
                const normalized = normalizeTaskStatusInput(parsedRecord.status, prevStatus)
                if (normalized) parsedRecord.status = normalized
                else delete parsedRecord.status
              }
              if (toolKey === 'manage_tasks' && Object.prototype.hasOwnProperty.call(parsedRecord, 'qualityGate')) {
                const settings = loadSettings()
                parsedRecord.qualityGate = parsedRecord.qualityGate
                  ? normalizeTaskQualityGate(parsedRecord.qualityGate, settings)
                  : null
              }
              if (toolKey === 'manage_tasks' || toolKey === 'manage_schedules') {
                const agents = loadAgents()
                const requestedClear = Object.prototype.hasOwnProperty.call(parsedRecord, 'agentId') && parsedRecord.agentId == null
                const shouldResolveAssignment = requestedClear
                  || hasManagedAgentAssignmentInput(parsedRecord)
                if (shouldResolveAssignment) {
                  const resolution = resolveManagedAgentAssignment(
                    parsedRecord,
                    agents,
                    null,
                    { allowDescription: false },
                  )
                  const assignmentError = validateManagedAgentAssignment({
                    resourceLabel: res.label,
                    agents,
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
                        }, agents, ctx?.agentId || null)
                      : null,
                  })
                  if (assignmentError) return assignmentError
                  if (!requestedClear) parsedRecord.agentId = resolution.agentId
                }
              }
              all[effectiveId] = { ...all[effectiveId], ...parsed, updatedAt: Date.now() }
              if (toolKey === 'manage_schedules') {
                const normalizedSchedule = normalizeSchedulePayload(all[effectiveId] as Record<string, unknown>, {
                  cwd,
                  now: Date.now(),
                })
                if (!normalizedSchedule.ok) return normalizedSchedule.error
                all[effectiveId] = {
                  ...all[effectiveId],
                  ...normalizedSchedule.value,
                  updatedAt: Date.now(),
                }
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
                  all[effectiveId].agentIds = Array.from(new Set([
                    ...incomingIds,
                    ...(ctx?.agentId ? [ctx.agentId] : []),
                  ]))
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

              if (toolKey === 'manage_tasks' && all[effectiveId].status === 'completed') {
                const { formatValidationFailure, validateTaskCompletion } = await import('../task-validation')
                const { ensureTaskCompletionReport } = await import('../task-reports')
                const settings = loadSettings()
                const report = ensureTaskCompletionReport(all[effectiveId] as any)
                if (report?.relativePath) (all[effectiveId] as any).completionReportPath = report.relativePath
                const validation = validateTaskCompletion(all[effectiveId] as any, { report, settings })
                ;(all[effectiveId] as any).validation = validation
                if (!validation.ok) {
                  all[effectiveId].status = 'failed'
                  ;(all[effectiveId] as any).completedAt = null
                  ;(all[effectiveId] as any).error = formatValidationFailure(validation.reasons).slice(0, 500)
                } else if ((all[effectiveId] as any).completedAt == null) {
                  ;(all[effectiveId] as any).completedAt = Date.now()
                }
              }

              res.save(all)
              if (toolKey === 'manage_projects') {
                ensureProjectWorkspace(effectiveId, all[effectiveId].name)
              }
              if (toolKey === 'manage_tasks' && prevStatus !== 'queued' && all[effectiveId].status === 'queued') {
                const { enqueueTask } = await import('../queue')
                enqueueTask(effectiveId)
              } else if (
                toolKey === 'manage_tasks'
                && prevStatus !== all[effectiveId].status
                && (all[effectiveId].status === 'completed' || all[effectiveId].status === 'failed')
                && all[effectiveId].sessionId
              ) {
                const { disableSessionHeartbeat } = await import('../queue')
                disableSessionHeartbeat(all[effectiveId].sessionId)
              }
              if (toolKey === 'manage_secrets') {
                const { encryptedValue, ...safe } = all[effectiveId]
                return JSON.stringify(safe)
              }
              if (toolKey === 'manage_projects') {
                return JSON.stringify(buildProjectSnapshot(all[effectiveId]))
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
              delete all[effectiveId]
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
                clearProjectId(loadTasks, saveTasks)
                clearProjectId(loadSchedules, saveSchedules)
                clearProjectId(loadSkills, saveSkills)
                clearProjectId(loadSecrets, saveSecrets)
              }
              return JSON.stringify({ deleted: effectiveId })
            }
            return `Unknown action "${action}". Valid: list, get, create, update, delete`
          } catch (err: any) {
            return `Error: ${err.message}`
          }
        },
        {
          name: toolKey,
          description,
          schema: z.object({
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
              const sourcePath = path.isAbsolute(filePath) ? filePath : safePath(cwd, filePath)
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
