import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import * as cheerio from 'cheerio'
import {
  loadAgents, saveAgents,
  loadTasks, saveTasks,
  loadSchedules, saveSchedules,
  loadSkills, saveSkills,
  loadConnectors, saveConnectors,
  loadDocuments, saveDocuments,
  loadWebhooks, saveWebhooks,
  loadSecrets, saveSecrets,
  loadSessions, saveSessions,
  encryptKey,
  decryptKey,
} from '../storage'
import { resolveScheduleName } from '@/lib/schedule-name'
import { findDuplicateSchedule, type ScheduleLike } from '@/lib/schedule-dedupe'
import type { ToolBuildContext } from './context'
import { safePath, findBinaryOnPath } from './context'

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
    isOrchestrator: p.isOrchestrator || false,
    tools: p.tools || [],
    skills: p.skills || [],
    skillIds: p.skillIds || [],
    subAgentIds: p.subAgentIds || [],
    ...p,
  }),
  manage_tasks: (p) => ({
    title: p.title || 'Untitled Task',
    description: p.description || '',
    status: p.status || 'backlog',
    agentId: p.agentId || null,
    sessionId: p.sessionId || null,
    result: null,
    error: null,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
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
  const { cwd, ctx, hasTool } = bctx

  // Build dynamic agent summary for tools that need agent awareness
  const assignScope = ctx?.platformAssignScope || 'self'
  let agentSummary = ''
  if (hasTool('manage_tasks') || hasTool('manage_schedules')) {
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
    if (!hasTool(toolKey)) continue

    let description = `Manage SwarmClaw ${res.label}. ${res.readOnly ? 'List and get only.' : 'List, get, create, update, or delete.'} Returns JSON.`
    if (toolKey === 'manage_tasks') {
      if (assignScope === 'self') {
        description += `\n\nSet "agentId" to assign a task to yourself ("${ctx?.agentId || 'unknown'}") or leave it null. You can only assign tasks to yourself. Valid statuses: backlog, queued, running, completed, failed.`
      } else {
        description += `\n\nSet "agentId" to assign a task to an agent (including yourself: "${ctx?.agentId || 'unknown'}"). Valid statuses: backlog, queued, running, completed, failed.` + agentSummary
      }
    } else if (toolKey === 'manage_agents') {
      description += `\n\nAgents may self-edit their own soul. To update your soul, use action="update", id="${ctx?.agentId || 'your-agent-id'}", and include data with the "soul" field.`
    } else if (toolKey === 'manage_schedules') {
      if (assignScope === 'self') {
        description += `\n\nSet "agentId" to assign a schedule to yourself ("${ctx?.agentId || 'unknown'}") or leave it null. You can only assign schedules to yourself. Schedule types: interval (set intervalMs), cron (set cron), once (set runAt). Set taskPrompt for what the agent should do. Before create, call list/get to avoid duplicate schedules. If an equivalent active/paused schedule already exists, create returns that existing schedule (deduplicated=true).`
      } else {
        description += `\n\nSet "agentId" to assign a schedule to an agent (including yourself: "${ctx?.agentId || 'unknown'}"). Schedule types: interval (set intervalMs), cron (set cron), once (set runAt). Set taskPrompt for what the agent should do. Before create, call list/get to avoid duplicate schedules. If an equivalent active/paused schedule already exists, create returns that existing schedule (deduplicated=true).` + agentSummary
      }
    } else if (toolKey === 'manage_webhooks') {
      description += '\n\nUse `source`, `events`, `agentId`, and `secret` when creating webhooks. Inbound calls should POST to `/api/webhooks/{id}` with header `x-webhook-secret` when a secret is configured.'
    }

    tools.push(
      tool(
        async ({ action, id, data }) => {
          const canAccessSecret = (secret: any): boolean => {
            if (!secret) return false
            if (secret.scope !== 'agent') return true
            if (!ctx?.agentId) return false
            return Array.isArray(secret.agentIds) && secret.agentIds.includes(ctx.agentId)
          }
          try {
            if (action === 'list') {
              if (toolKey === 'manage_secrets') {
                const values = Object.values(res.load())
                  .filter((s: any) => canAccessSecret(s))
                  .map((s: any) => ({
                    id: s.id,
                    name: s.name,
                    service: s.service,
                    scope: s.scope || 'global',
                    agentIds: s.agentIds || [],
                    createdAt: s.createdAt,
                    updatedAt: s.updatedAt,
                  }))
                return JSON.stringify(values)
              }
              return JSON.stringify(Object.values(res.load()))
            }
            if (action === 'get') {
              if (!id) return 'Error: "id" is required for get action.'
              const all = res.load()
              if (!all[id]) return `Not found: ${res.label} "${id}"`
              if (toolKey === 'manage_secrets') {
                if (!canAccessSecret(all[id])) return 'Error: you do not have access to this secret.'
                let value = ''
                try {
                  value = all[id].encryptedValue ? decryptKey(all[id].encryptedValue) : ''
                } catch {
                  value = ''
                }
                return JSON.stringify({
                  id: all[id].id,
                  name: all[id].name,
                  service: all[id].service,
                  scope: all[id].scope || 'global',
                  agentIds: all[id].agentIds || [],
                  value,
                  createdAt: all[id].createdAt,
                  updatedAt: all[id].updatedAt,
                })
              }
              return JSON.stringify(all[id])
            }
            if (res.readOnly) return `Cannot ${action} ${res.label} via this tool (read-only).`
            if (action === 'create') {
              const all = res.load()
              const raw = data ? JSON.parse(data) : {}
              const defaults = RESOURCE_DEFAULTS[toolKey]
              const parsed = defaults ? defaults(raw) : raw
              if (parsed && typeof parsed === 'object' && 'id' in parsed) {
                delete (parsed as Record<string, unknown>).id
              }
              // Enforce assignment scope for tasks and schedules
              if (assignScope === 'self' && (toolKey === 'manage_tasks' || toolKey === 'manage_schedules')) {
                if (parsed.agentId && parsed.agentId !== ctx?.agentId) {
                  return `Error: You can only assign ${res.label} to yourself ("${ctx?.agentId}"). To assign to other agents, ask a user to enable "Assign to Other Agents" in your agent settings.`
                }
              }
              const now = Date.now()
              if (toolKey === 'manage_schedules') {
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
              const newId = crypto.randomBytes(4).toString('hex')
              const entry = {
                id: newId,
                ...parsed,
                createdByAgentId: ctx?.agentId || null,
                createdInSessionId: ctx?.sessionId || null,
                createdAt: now,
                updatedAt: now,
              }
              let responseEntry: any = entry
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
                  encryptedValue: encryptKey(secretValue),
                }
                delete (stored as any).value
                all[newId] = stored
                const { encryptedValue, ...safe } = stored
                responseEntry = safe
              } else {
                all[newId] = entry
              }

              if (toolKey === 'manage_tasks' && entry.status === 'completed') {
                const { formatValidationFailure, validateTaskCompletion } = await import('../task-validation')
                const { ensureTaskCompletionReport } = await import('../task-reports')
                const report = ensureTaskCompletionReport(entry as any)
                if (report?.relativePath) (entry as any).completionReportPath = report.relativePath
                const validation = validateTaskCompletion(entry as any, { report })
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
              if (!id) return 'Error: "id" is required for update action.'
              const all = res.load()
              if (!all[id]) return `Not found: ${res.label} "${id}"`
              const parsed = data ? JSON.parse(data) : {}
              const prevStatus = all[id]?.status
              // Enforce assignment scope for tasks and schedules
              if (assignScope === 'self' && (toolKey === 'manage_tasks' || toolKey === 'manage_schedules')) {
                if (parsed.agentId && parsed.agentId !== ctx?.agentId) {
                  return `Error: You can only assign ${res.label} to yourself ("${ctx?.agentId}"). To assign to other agents, ask a user to enable "Assign to Other Agents" in your agent settings.`
                }
              }
              all[id] = { ...all[id], ...parsed, updatedAt: Date.now() }
              if (toolKey === 'manage_secrets') {
                if (!canAccessSecret(all[id])) return 'Error: you do not have access to this secret.'
                const nextScope = parsed.scope === 'agent'
                  ? 'agent'
                  : parsed.scope === 'global'
                    ? 'global'
                    : (all[id].scope === 'agent' ? 'agent' : 'global')
                if (nextScope === 'agent') {
                  const incomingIds = Array.isArray(parsed.agentIds)
                    ? parsed.agentIds.filter((x: any) => typeof x === 'string')
                    : Array.isArray(all[id].agentIds)
                      ? all[id].agentIds
                      : []
                  all[id].agentIds = Array.from(new Set([
                    ...incomingIds,
                    ...(ctx?.agentId ? [ctx.agentId] : []),
                  ]))
                } else {
                  all[id].agentIds = []
                }
                all[id].scope = nextScope
                if (typeof parsed.value === 'string' && parsed.value.trim()) {
                  all[id].encryptedValue = encryptKey(parsed.value)
                }
                delete all[id].value
              }

              if (toolKey === 'manage_tasks' && all[id].status === 'completed') {
                const { formatValidationFailure, validateTaskCompletion } = await import('../task-validation')
                const { ensureTaskCompletionReport } = await import('../task-reports')
                const report = ensureTaskCompletionReport(all[id] as any)
                if (report?.relativePath) (all[id] as any).completionReportPath = report.relativePath
                const validation = validateTaskCompletion(all[id] as any, { report })
                ;(all[id] as any).validation = validation
                if (!validation.ok) {
                  all[id].status = 'failed'
                  ;(all[id] as any).completedAt = null
                  ;(all[id] as any).error = formatValidationFailure(validation.reasons).slice(0, 500)
                } else if ((all[id] as any).completedAt == null) {
                  ;(all[id] as any).completedAt = Date.now()
                }
              }

              res.save(all)
              if (toolKey === 'manage_tasks' && prevStatus !== 'queued' && all[id].status === 'queued') {
                const { enqueueTask } = await import('../queue')
                enqueueTask(id)
              } else if (
                toolKey === 'manage_tasks'
                && prevStatus !== all[id].status
                && (all[id].status === 'completed' || all[id].status === 'failed')
                && all[id].sessionId
              ) {
                const { disableSessionHeartbeat } = await import('../queue')
                disableSessionHeartbeat(all[id].sessionId)
              }
              if (toolKey === 'manage_secrets') {
                const { encryptedValue, ...safe } = all[id]
                return JSON.stringify(safe)
              }
              return JSON.stringify(all[id])
            }
            if (action === 'delete') {
              if (!id) return 'Error: "id" is required for delete action.'
              const all = res.load()
              if (!all[id]) return `Not found: ${res.label} "${id}"`
              if (toolKey === 'manage_secrets' && !canAccessSecret(all[id])) {
                return 'Error: you do not have access to this secret.'
              }
              delete all[id]
              res.save(all)
              return JSON.stringify({ deleted: id })
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
          }),
        },
      ),
    )
  }

  if (hasTool('manage_documents')) {
    tools.push(
      tool(
        async ({ action, id, filePath, query, limit, metadata, title }) => {
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

              const docId = crypto.randomBytes(6).toString('hex')
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
