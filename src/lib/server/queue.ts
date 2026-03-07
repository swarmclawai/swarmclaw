import { genId } from '@/lib/id'
import fs from 'node:fs'
import path from 'node:path'
import { loadTasks, saveTasks, loadQueue, saveQueue, loadAgents, loadSchedules, saveSchedules, loadSessions, saveSessions, loadSettings, loadConnectors, UPLOAD_DIR } from './storage'
import { notify } from './ws-hub'
import { WORKSPACE_DIR } from './data-dir'
import { createOrchestratorSession } from './orchestrator'
import { formatValidationFailure, validateTaskCompletion } from './task-validation'
import { ensureTaskCompletionReport } from './task-reports'
import { pushMainLoopEventToMainSessions } from './main-agent-loop'
import { executeSessionChatTurn } from './chat-execution'
import { extractTaskResult, formatResultBody } from './task-result'
import { getCheckpointSaver } from './langgraph-checkpoint'
import { cascadeUnblock } from './dag-validation'
import { performGuardianRollback } from './guardian'
import type { Agent, BoardTask, Connector, Message, Session } from '@/types'

// HMR-safe: pin processing flag to globalThis so hot reloads don't reset it
const _queueState = ((globalThis as Record<string, unknown>).__swarmclaw_queue__ ??= { processing: false, pendingKick: false }) as { processing: boolean; pendingKick: boolean }

interface SessionMessageLike {
  role?: string
  text?: string
  time?: number
  kind?: string
  source?: {
    connectorId?: string
    channelId?: string
  }
  toolEvents?: Array<{ name?: string; output?: string }>
  streaming?: boolean
  imageUrl?: string
}

interface SessionLike {
  name?: string
  user?: string
  cwd?: string
  messages?: SessionMessageLike[]
  lastActiveAt?: number
}

interface ScheduleTaskMeta extends BoardTask {
  user?: string | null
  createdInSessionId?: string | null
  createdByAgentId?: string | null
}

interface RunningConnectorLike {
  id: string
  platform: string
  agentId: string | null
  supportsSend: boolean
  configuredTargets: string[]
  recentChannelId: string | null
}

interface ConnectorTaskFollowupTarget {
  connectorId: string
  channelId: string
}

function sameReasons(a?: string[] | null, b?: string[] | null): boolean {
  const av = Array.isArray(a) ? a : []
  const bv = Array.isArray(b) ? b : []
  if (av.length !== bv.length) return false
  for (let i = 0; i < av.length; i++) {
    if (av[i] !== bv[i]) return false
  }
  return true
}

function normalizeInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

const OPENCLAW_USE_CASE_TAGS = new Set([
  'local-dev',
  'single-vps',
  'private-tailnet',
  'browser-heavy',
  'team-control',
])

function deriveTaskRoutePreferences(task: BoardTask): {
  preferredGatewayTags?: string[]
  preferredGatewayUseCase?: string | null
} {
  const tags = Array.isArray(task.tags)
    ? [...new Set(task.tags.map((tag) => (typeof tag === 'string' ? tag.trim().toLowerCase() : '')).filter(Boolean))]
    : []
  const customUseCase = typeof task.customFields?.openclawUseCase === 'string'
    ? task.customFields.openclawUseCase
    : typeof task.customFields?.gatewayUseCase === 'string'
      ? task.customFields.gatewayUseCase
      : null
  const preferredGatewayUseCase = customUseCase && OPENCLAW_USE_CASE_TAGS.has(customUseCase)
    ? customUseCase
    : (tags.find((tag) => OPENCLAW_USE_CASE_TAGS.has(tag)) || null)
  const preferredGatewayTags = tags.filter((tag) => tag !== preferredGatewayUseCase)
  return {
    preferredGatewayTags,
    preferredGatewayUseCase,
  }
}

function resolveTaskPolicy(task: BoardTask): { maxAttempts: number; backoffSec: number } {
  const settings = loadSettings()
  const defaultMaxAttempts = normalizeInt(settings.defaultTaskMaxAttempts, 3, 1, 20)
  const defaultBackoffSec = normalizeInt(settings.taskRetryBackoffSec, 30, 1, 3600)
  const maxAttempts = normalizeInt(task.maxAttempts, defaultMaxAttempts, 1, 20)
  const backoffSec = normalizeInt(task.retryBackoffSec, defaultBackoffSec, 1, 3600)
  return { maxAttempts, backoffSec }
}

function applyTaskPolicyDefaults(task: BoardTask): void {
  const policy = resolveTaskPolicy(task)
  if (typeof task.attempts !== 'number' || task.attempts < 0) task.attempts = 0
  task.maxAttempts = policy.maxAttempts
  task.retryBackoffSec = policy.backoffSec
  if (task.retryScheduledAt === undefined) task.retryScheduledAt = null
  if (task.deadLetteredAt === undefined) task.deadLetteredAt = null
}

export interface TaskResumeState {
  claudeSessionId: string | null
  codexThreadId: string | null
  opencodeSessionId: string | null
  delegateResumeIds: NonNullable<Session['delegateResumeIds']>
}

export interface TaskResumeContext {
  source: 'self' | 'delegated_from_task' | 'blocked_by'
  sourceTaskId: string
  sourceTaskTitle: string
  sourceSessionId: string | null
  resume: TaskResumeState
}

function normalizeResumeHandle(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function buildEmptyDelegateResumeIds(): NonNullable<Session['delegateResumeIds']> {
  return {
    claudeCode: null,
    codex: null,
    opencode: null,
    gemini: null,
  }
}

function normalizeCliProvider(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null
}

function hasResumeState(state: TaskResumeState | null | undefined): state is TaskResumeState {
  if (!state) return false
  return Boolean(
    state.claudeSessionId
    || state.codexThreadId
    || state.opencodeSessionId
    || state.delegateResumeIds.claudeCode
    || state.delegateResumeIds.codex
    || state.delegateResumeIds.opencode
    || state.delegateResumeIds.gemini
  )
}

export function extractTaskResumeState(task: Partial<BoardTask> | null | undefined): TaskResumeState | null {
  if (!task) return null

  const legacyResumeId = normalizeResumeHandle(task.cliResumeId)
  const legacyProvider = normalizeCliProvider(task.cliProvider)
  const claudeSessionId = normalizeResumeHandle(task.claudeResumeId)
    || (legacyProvider === 'claude-cli' ? legacyResumeId : null)
  const codexThreadId = normalizeResumeHandle(task.codexResumeId)
    || (legacyProvider === 'codex-cli' ? legacyResumeId : null)
  const opencodeSessionId = normalizeResumeHandle(task.opencodeResumeId)
    || (legacyProvider === 'opencode-cli' ? legacyResumeId : null)
  const geminiSessionId = normalizeResumeHandle(task.geminiResumeId)
    || (legacyProvider === 'gemini-cli' ? legacyResumeId : null)

  const resume = {
    claudeSessionId,
    codexThreadId,
    opencodeSessionId,
    delegateResumeIds: {
      claudeCode: claudeSessionId,
      codex: codexThreadId,
      opencode: opencodeSessionId,
      gemini: geminiSessionId,
    },
  } satisfies TaskResumeState

  return hasResumeState(resume) ? resume : null
}

export function extractSessionResumeState(session: Partial<Session> | null | undefined): TaskResumeState | null {
  if (!session) return null

  const claudeSessionId = normalizeResumeHandle(session.claudeSessionId)
  const codexThreadId = normalizeResumeHandle(session.codexThreadId)
  const opencodeSessionId = normalizeResumeHandle(session.opencodeSessionId)
  const delegateResumeIds = session.delegateResumeIds && typeof session.delegateResumeIds === 'object'
    ? { ...buildEmptyDelegateResumeIds(), ...session.delegateResumeIds }
    : buildEmptyDelegateResumeIds()

  const resume = {
    claudeSessionId,
    codexThreadId,
    opencodeSessionId,
    delegateResumeIds: {
      claudeCode: normalizeResumeHandle(delegateResumeIds.claudeCode) || claudeSessionId,
      codex: normalizeResumeHandle(delegateResumeIds.codex) || codexThreadId,
      opencode: normalizeResumeHandle(delegateResumeIds.opencode) || opencodeSessionId,
      gemini: normalizeResumeHandle(delegateResumeIds.gemini),
    },
  } satisfies TaskResumeState

  return hasResumeState(resume) ? resume : null
}

export function resolveTaskResumeContext(
  task: BoardTask,
  tasksById: Record<string, BoardTask>,
  sessionsById?: Record<string, SessionLike | Session>,
): TaskResumeContext | null {
  const candidates: Array<{ source: TaskResumeContext['source']; taskId: string | null | undefined }> = [
    { source: 'self', taskId: task.id },
    { source: 'delegated_from_task', taskId: task.delegatedFromTaskId },
    ...((Array.isArray(task.blockedBy) ? task.blockedBy : []).map((taskId) => ({ source: 'blocked_by' as const, taskId }))),
  ]
  const seen = new Set<string>()

  for (const candidate of candidates) {
    const taskId = typeof candidate.taskId === 'string' ? candidate.taskId.trim() : ''
    if (!taskId || seen.has(taskId)) continue
    seen.add(taskId)
    const sourceTask = taskId === task.id ? task : tasksById[taskId]
    if (!sourceTask) continue
    const sourceSessionId = normalizeResumeHandle(sourceTask.checkpoint?.lastSessionId) || normalizeResumeHandle(sourceTask.sessionId)
    const resume = extractTaskResumeState(sourceTask)
      || (sourceSessionId && sessionsById?.[sourceSessionId]
        ? extractSessionResumeState(sessionsById[sourceSessionId] as Session)
        : null)
    if (!resume) continue
    return {
      source: candidate.source,
      sourceTaskId: sourceTask.id,
      sourceTaskTitle: sourceTask.title,
      sourceSessionId,
      resume,
    }
  }

  return null
}

export function applyTaskResumeStateToSession(session: Session, resume: TaskResumeState | null | undefined): boolean {
  if (!hasResumeState(resume)) return false

  let changed = false
  const directFields: Array<['claudeSessionId' | 'codexThreadId' | 'opencodeSessionId', string | null]> = [
    ['claudeSessionId', resume.claudeSessionId],
    ['codexThreadId', resume.codexThreadId],
    ['opencodeSessionId', resume.opencodeSessionId],
  ]
  for (const [key, value] of directFields) {
    if (!value || session[key] === value) continue
    session[key] = value
    changed = true
  }

  const currentDelegateResume = session.delegateResumeIds && typeof session.delegateResumeIds === 'object'
    ? { ...buildEmptyDelegateResumeIds(), ...session.delegateResumeIds }
    : buildEmptyDelegateResumeIds()
  for (const [key, value] of Object.entries(resume.delegateResumeIds) as Array<[keyof NonNullable<Session['delegateResumeIds']>, string | null]>) {
    if (!value || currentDelegateResume[key] === value) continue
    currentDelegateResume[key] = value
    changed = true
  }
  if (changed) session.delegateResumeIds = currentDelegateResume
  return changed
}

export function resolveReusableTaskSessionId(
  task: BoardTask,
  tasks: Record<string, BoardTask>,
  sessions: Record<string, SessionLike>,
): string {
  const candidateTaskIds = [
    task.id,
    typeof task.delegatedFromTaskId === 'string' ? task.delegatedFromTaskId : '',
    ...(Array.isArray(task.blockedBy) ? task.blockedBy : []),
  ]
  const seen = new Set<string>()
  for (const candidateTaskId of candidateTaskIds) {
    const taskId = typeof candidateTaskId === 'string' ? candidateTaskId.trim() : ''
    if (!taskId || seen.has(taskId)) continue
    seen.add(taskId)
    const sourceTask = taskId === task.id ? task : tasks[taskId]
    if (!sourceTask) continue
    const candidates = [
      normalizeResumeHandle(sourceTask.checkpoint?.lastSessionId),
      normalizeResumeHandle(sourceTask.sessionId),
    ]
    for (const candidate of candidates) {
      if (candidate && sessions[candidate]) return candidate
    }
  }
  return ''
}

function buildTaskContinuationNote(
  reusedExistingSession: boolean,
  resumeContext: TaskResumeContext | null,
): string {
  const notes: string[] = []
  if (reusedExistingSession) {
    notes.push('Reusing the previous execution session for this task.')
  }
  if (resumeContext?.source === 'delegated_from_task' || resumeContext?.source === 'blocked_by') {
    notes.push(`Stored CLI context is available from related task "${resumeContext.sourceTaskTitle}".`)
  } else if (resumeContext?.source === 'self' && !reusedExistingSession) {
    notes.push('Stored CLI resume handles are available for continuation.')
  }
  return notes.length ? `\n\n${notes.join(' ')}` : ''
}

const DEV_TASK_HINT = /\b(dev(?:\s+server)?|start(?:ing)?\s+(?:the\s+)?server|run(?:ning)?\s+(?:the\s+)?(?:app|project|site)|serve|localhost|http\s+server|web\s+server|npm\b|pnpm\b|yarn\b|bun\b|vite|next(?:\.js)?|react|build|compile)\b/i
const TASK_CWD_NOISE_DIRS = new Set([
  'uploads',
  'data',
  'projects',
  'tasks',
  '.swarm-data-test',
  '.git',
  '.next',
  'node_modules',
])
const PROJECT_MARKER_FILES = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', '.git']
const SOURCE_MARKER_DIRS = ['src', 'app', 'public', 'pages']
const WORKSPACE_PROJECTS_DIR = path.join(WORKSPACE_DIR, 'projects')

interface WorkspaceDirCandidate {
  dir: string
  name: string
  hasProjectMarker: boolean
  hasSourceMarker: boolean
}

let workspaceDirCache: { expiresAt: number; candidates: WorkspaceDirCandidate[] } | null = null

function isExistingDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

function isWithinDirectory(parent: string, child: string): boolean {
  const parentResolved = path.resolve(parent)
  const childResolved = path.resolve(child)
  const rel = path.relative(parentResolved, childResolved)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function hasAnyMarker(dirPath: string, markers: string[]): boolean {
  return markers.some((marker) => fs.existsSync(path.join(dirPath, marker)))
}

function normalizeDirCandidate(raw: unknown, baseDir: string): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const homeDir = process.env.HOME || ''
  const expanded = trimmed === '~'
    ? homeDir
    : trimmed.startsWith('~/')
      ? path.join(homeDir, trimmed.slice(2))
      : trimmed
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded)
  return isExistingDirectory(resolved) ? resolved : null
}

function looksLikeDevTask(task: Pick<BoardTask, 'title' | 'description'>): boolean {
  const text = `${task.title || ''} ${task.description || ''}`.trim()
  return DEV_TASK_HINT.test(text)
}

function listWorkspaceDirCandidates(): WorkspaceDirCandidate[] {
  const now = Date.now()
  if (workspaceDirCache && workspaceDirCache.expiresAt > now) return workspaceDirCache.candidates

  const candidates: WorkspaceDirCandidate[] = []
  const seen = new Set<string>()
  const roots = [WORKSPACE_DIR, WORKSPACE_PROJECTS_DIR]

  for (const root of roots) {
    if (!isExistingDirectory(root)) continue
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      if (!name || name.startsWith('.')) continue
      if (TASK_CWD_NOISE_DIRS.has(name)) continue
      const dir = path.join(root, name)
      const key = path.resolve(dir)
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({
        dir: key,
        name,
        hasProjectMarker: hasAnyMarker(key, PROJECT_MARKER_FILES),
        hasSourceMarker: hasAnyMarker(key, SOURCE_MARKER_DIRS),
      })
    }
  }

  candidates.sort((a, b) => a.name.localeCompare(b.name))
  workspaceDirCache = {
    expiresAt: now + 15_000,
    candidates,
  }
  return candidates
}

function inferWorkspaceProjectCwd(task: Pick<BoardTask, 'title' | 'description' | 'file'>): string | null {
  const candidates = listWorkspaceDirCandidates()
  if (!candidates.length) return null

  const taskText = normalizeForMatch(`${task.title || ''} ${task.description || ''} ${task.file || ''}`)
  const devTask = looksLikeDevTask(task)
  const markerCandidates = candidates.filter((candidate) => candidate.hasProjectMarker)

  let best: { dir: string; score: number } | null = null
  for (const candidate of candidates) {
    const nameNorm = normalizeForMatch(candidate.name)
    if (!nameNorm) continue
    let score = 0
    if (taskText.includes(nameNorm)) score += 8
    for (const token of nameNorm.split(' ')) {
      if (token.length < 3) continue
      if (taskText.includes(token)) score += 1
    }
    if (candidate.hasProjectMarker) score += devTask ? 3 : 1
    if (candidate.hasSourceMarker) score += 1
    if (!best || score > best.score) best = { dir: candidate.dir, score }
  }

  if (best && best.score >= 4) return best.dir
  if (devTask && markerCandidates.length === 1) return markerCandidates[0].dir
  return null
}

function resolveTaskExecutionCwd(task: ScheduleTaskMeta, sessions: Record<string, SessionLike>): string {
  const workspaceRoot = path.resolve(WORKSPACE_DIR)

  const explicitCwd = normalizeDirCandidate(task.cwd, workspaceRoot)
  if (explicitCwd) return explicitCwd

  const projectId = typeof task.projectId === 'string' ? task.projectId.trim() : ''
  if (projectId) {
    const projectDir = path.join(WORKSPACE_PROJECTS_DIR, projectId)
    if (isExistingDirectory(projectDir)) return projectDir
  }

  const fileRef = typeof task.file === 'string' ? task.file.trim() : ''
  if (fileRef) {
    const filePath = path.isAbsolute(fileRef) ? fileRef : path.resolve(workspaceRoot, fileRef)
    const fileDir = isExistingDirectory(filePath) ? filePath : path.dirname(filePath)
    if (isExistingDirectory(fileDir) && isWithinDirectory(workspaceRoot, fileDir)) return fileDir
  }

  const inferredCwd = inferWorkspaceProjectCwd(task)
  if (inferredCwd) return inferredCwd

  const sourceSessionId = typeof task.createdInSessionId === 'string' ? task.createdInSessionId.trim() : ''
  const sourceSessionCwd = sourceSessionId
    ? normalizeDirCandidate(sessions[sourceSessionId]?.cwd, workspaceRoot)
    : null
  if (sourceSessionCwd && path.resolve(sourceSessionCwd) !== workspaceRoot) return sourceSessionCwd

  const runSessionId = typeof task.sessionId === 'string' ? task.sessionId.trim() : ''
  const runSessionCwd = runSessionId
    ? normalizeDirCandidate(sessions[runSessionId]?.cwd, workspaceRoot)
    : null
  if (runSessionCwd && path.resolve(runSessionCwd) !== workspaceRoot) return runSessionCwd

  const sandboxDir = path.join(workspaceRoot, 'tasks', task.id)
  fs.mkdirSync(sandboxDir, { recursive: true })
  return sandboxDir
}

function queueContains(queue: string[], id: string): boolean {
  return queue.includes(id)
}

function pushQueueUnique(queue: string[], id: string): void {
  if (!queueContains(queue, id)) queue.push(id)
}

function resolveTaskOwnerUser(task: ScheduleTaskMeta, sessions: Record<string, SessionLike>): string | null {
  const direct = typeof task.user === 'string' ? task.user.trim() : ''
  if (direct) return direct
  const createdInSessionId = typeof task.createdInSessionId === 'string'
    ? task.createdInSessionId
    : ''
  if (createdInSessionId) {
    const sourceSession = sessions[createdInSessionId]
    const sourceUser = typeof sourceSession?.user === 'string' ? sourceSession.user.trim() : ''
    if (sourceUser) return sourceUser
  }
  return null
}

function latestAssistantText(session: SessionLike | null | undefined): string {
  if (!Array.isArray(session?.messages)) return ''
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i]
    if (msg?.role !== 'assistant') continue
    const text = typeof msg?.text === 'string' ? msg.text.trim() : ''
    if (!text) continue
    if (/^HEARTBEAT_OK$/i.test(text)) continue
    return text
  }
  return ''
}

function isEnabledFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1'
    || normalized === 'true'
    || normalized === 'yes'
    || normalized === 'on'
    || normalized === 'enabled'
}

function normalizeWhatsappTarget(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  if (trimmed.includes('@')) return trimmed
  let cleaned = trimmed.replace(/[^\d+]/g, '')
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1)
  if (cleaned.startsWith('0') && cleaned.length >= 10) {
    cleaned = `44${cleaned.slice(1)}`
  }
  cleaned = cleaned.replace(/[^\d]/g, '')
  return cleaned ? `${cleaned}@s.whatsapp.net` : trimmed
}

function fillTaskFollowupTemplate(template: string, data: {
  status: string
  title: string
  summary: string
  taskId: string
}): string {
  return template
    .replaceAll('{status}', data.status)
    .replaceAll('{title}', data.title)
    .replaceAll('{summary}', data.summary)
    .replaceAll('{taskId}', data.taskId)
}

function maybeResolveUploadMediaPathFromUrl(url: string | undefined): string | undefined {
  if (!url || !url.startsWith('/api/uploads/')) return undefined
  const rawName = url.slice('/api/uploads/'.length).split(/[?#]/)[0] || ''
  let decoded: string
  try { decoded = decodeURIComponent(rawName) } catch { decoded = rawName }
  const safeName = decoded.replace(/[^a-zA-Z0-9._-]/g, '')
  if (!safeName) return undefined
  const fullPath = path.join(UPLOAD_DIR, safeName)
  return fs.existsSync(fullPath) ? fullPath : undefined
}

const OUTPUT_FILE_BACKTICK_RE = /`([^`\n]+\.(?:txt|md|json|csv|pdf|png|jpe?g|webp|gif|svg|mp4|webm|mov|zip|tar|gz|log|yml|yaml|xml|html|css|js|ts|tsx|jsx|py|go|rs|java|swift|kt|sql))`/gi
const OUTPUT_FILE_PATH_RE = /\b((?:\.{1,2}\/|~\/|\/)?[\w./-]+\.(?:txt|md|json|csv|pdf|png|jpe?g|webp|gif|svg|mp4|webm|mov|zip|tar|gz|log|yml|yaml|xml|html|css|js|ts|tsx|jsx|py|go|rs|java|swift|kt|sql))\b/gi
const MAX_CONNECTOR_ATTACHMENT_BYTES = 25 * 1024 * 1024

function extractLikelyOutputFiles(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    const value = raw.trim().replace(/^['"]|['"]$/g, '')
    if (!value || /^https?:\/\//i.test(value)) return
    if (value.startsWith('/api/uploads/')) return
    const key = value.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(value)
  }

  for (const match of text.matchAll(OUTPUT_FILE_BACKTICK_RE)) {
    push(match[1] || '')
    if (out.length >= 8) return out
  }
  for (const match of text.matchAll(OUTPUT_FILE_PATH_RE)) {
    push(match[1] || '')
    if (out.length >= 8) return out
  }

  return out
}

function resolveExistingOutputFilePath(fileRef: string, cwd: string): string | null {
  const ref = (fileRef || '').trim()
  if (!ref) return null
  if (ref.startsWith('/api/uploads/')) {
    return maybeResolveUploadMediaPathFromUrl(ref) || null
  }
  const withoutFileScheme = ref.replace(/^file:\/\//i, '')
  const candidates = path.isAbsolute(withoutFileScheme)
    ? [withoutFileScheme]
    : [
        cwd ? path.resolve(cwd, withoutFileScheme) : '',
        path.resolve(WORKSPACE_DIR, withoutFileScheme),
      ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile()) return candidate
    } catch {
      // ignore missing candidate
    }
  }
  return null
}

function isSendableAttachment(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath)
    return stat.isFile() && stat.size <= MAX_CONNECTOR_ATTACHMENT_BYTES
  } catch {
    return false
  }
}

export function resolveTaskOriginConnectorFollowupTarget(params: {
  task: BoardTask
  sessions: Record<string, SessionLike>
  connectors: Record<string, Connector>
  running: RunningConnectorLike[]
}): ConnectorTaskFollowupTarget | null {
  const { task, sessions, connectors, running } = params
  const metaTask = task as ScheduleTaskMeta
  const delegatedByAgentId = typeof metaTask.delegatedByAgentId === 'string'
    ? metaTask.delegatedByAgentId.trim()
    : ''
  const sourceSessionId = typeof metaTask.createdInSessionId === 'string'
    ? metaTask.createdInSessionId.trim()
    : ''
  if (!sourceSessionId) return null
  const sourceSession = sessions[sourceSessionId]
  if (!sourceSession || !Array.isArray(sourceSession.messages)) return null

  const runningById = new Map<string, RunningConnectorLike>()
  for (const entry of running) {
    if (!entry?.id) continue
    runningById.set(entry.id, entry)
  }

  for (let i = sourceSession.messages.length - 1; i >= 0; i--) {
    const message = sourceSession.messages[i]
    if (!message || message.role !== 'user') continue

    const connectorId = typeof message.source?.connectorId === 'string'
      ? message.source.connectorId.trim()
      : ''
    if (!connectorId) continue

    const connector = connectors[connectorId]
    if (!connector) continue
    const ownerId = typeof connector.agentId === 'string' ? connector.agentId.trim() : ''
    if (ownerId) {
      const allowedOwners = new Set([task.agentId, delegatedByAgentId].filter(Boolean))
      if (!allowedOwners.has(ownerId)) continue
    }

    const runtime = runningById.get(connectorId)
    if (runtime && !runtime.supportsSend) continue

    const sourceChannel = typeof message.source?.channelId === 'string'
      ? message.source.channelId.trim()
      : ''
    const fallbackChannel = runtime?.recentChannelId
      || runtime?.configuredTargets?.[0]
      || connector.config?.outboundJid
      || connector.config?.outboundTarget
      || ''
    const rawChannel = sourceChannel || fallbackChannel
    if (!rawChannel) continue

    return {
      connectorId,
      channelId: connector.platform === 'whatsapp'
        ? normalizeWhatsappTarget(rawChannel)
        : rawChannel,
    }
  }

  return null
}

// Task result extraction now uses Zod-validated structured data
// from ./task-result.ts (extractTaskResult, formatResultBody)

/** Check if a task result looks incomplete (agent stopped mid-objective). */
function looksIncomplete(text: string): boolean {
  if (!text) return false
  const trimmed = text.trim()
  // Ends with ellipsis or continuation signal
  if (trimmed.endsWith('...') || trimmed.endsWith('…')) return true
  // Ends with a step/phase header (agent was listing next steps)
  if (/(?:^|\n)#{1,3}\s+(?:Step|Phase|Next)\s+\d/i.test(trimmed.slice(-200))) return true
  // Contains forward-looking language at the end
  const lastChunk = trimmed.slice(-300).toLowerCase()
  if (/\b(?:next i(?:'ll| will)|now i(?:'ll| will)|let me (?:now|next)|moving on to|proceeding to)\b/.test(lastChunk)) return true
  return false
}

async function executeTaskRun(
  task: BoardTask,
  agent: Agent,
  sessionId: string,
): Promise<string> {
  const basePrompt = task.description || task.title
  const prompt = [
    basePrompt,
    '',
    'Completion requirements:',
    '- Execute the task before replying; do not reply with only a plan.',
    '- Include concrete evidence in your final summary: changed file paths, commands run, and verification results.',
    '- If blocked, state the blocker explicitly and what input or permission is missing.',
  ].join('\n')
  // All agents (including orchestrators) go through the unified chat execution path.
  // Agents with subAgentIds get delegation tools automatically via session-tools.
  const run = await executeSessionChatTurn({
    sessionId,
    message: prompt,
    internal: false,
    source: 'task',
    runId: task.id,
  })
  let text = typeof run.text === 'string' ? run.text.trim() : ''
  if (run.error) return text ? text : `Error: ${run.error}`

  // Auto-continue if the result looks incomplete
  if (text && looksIncomplete(text)) {
    const followUp = await executeSessionChatTurn({
      sessionId,
      message: 'Continue and complete the remaining steps. Provide a final summary when done.',
      internal: false,
      source: 'task',
    })
    const contText = typeof followUp.text === 'string' ? followUp.text.trim() : ''
    if (contText) text = contText
  }

  return text
}

function notifyMainChatScheduleResult(task: BoardTask): void {
  const scheduleTask = task as ScheduleTaskMeta
  const sourceType = typeof scheduleTask.sourceType === 'string' ? scheduleTask.sourceType : ''
  if (sourceType !== 'schedule') return
  if (task.status !== 'completed' && task.status !== 'failed') return

  const sessions = loadSessions()
  void resolveTaskOwnerUser(scheduleTask, sessions as Record<string, SessionLike>)
  const scheduleNameRaw = typeof scheduleTask.sourceScheduleName === 'string'
    ? scheduleTask.sourceScheduleName.trim()
    : ''
  const scheduleName = scheduleNameRaw || (task.title || 'Scheduled Task').replace(/^\[Sched\]\s*/i, '').trim()

  const runSessionId = typeof task.sessionId === 'string' ? task.sessionId : ''
  const runSession = runSessionId ? sessions[runSessionId] : null
  const fallbackText = runSession ? latestAssistantText(runSession) : ''

  // Zod-validated structured extraction: one pass to get summary + all artifacts
  const taskResult = extractTaskResult(
    runSession,
    task.result || fallbackText || null,
    { sinceTime: typeof task.startedAt === 'number' ? task.startedAt : null },
  )
  const resultBody = formatResultBody(taskResult)

  const statusLabel = task.status === 'completed' ? 'completed' : 'failed'
  const srcScheduleId = typeof scheduleTask.sourceScheduleId === 'string' ? scheduleTask.sourceScheduleId : ''
  const taskLink = `[${task.title}](#task:${task.id})`
  const schedLink = srcScheduleId ? ` | [Schedule](#schedule:${srcScheduleId})` : ''
  const body = [
    `Scheduled run ${statusLabel}: **${scheduleName || 'Scheduled Task'}** ${taskLink}${schedLink}`,
    resultBody || 'No summary was returned.',
  ].join('\n\n').trim()
  if (!body) return

  // First image artifact goes on imageUrl for the inline preview above markdown
  const firstImage = taskResult.artifacts.find((a) => a.type === 'image')
  const now = Date.now()
  let changed = false

  const buildMsg = (): SessionMessageLike => {
    const msg: SessionMessageLike = { role: 'assistant', text: body, time: now, kind: 'system' }
    if (firstImage) msg.imageUrl = firstImage.url
    return msg
  }

  // Push to the agent's shortcut chat session.
  try {
    const agents = loadAgents()
    const agent = agents[task.agentId]
    if (agent?.threadSessionId && sessions[agent.threadSessionId]) {
      const thread = sessions[agent.threadSessionId] as SessionLike
      const threadLast = Array.isArray(thread.messages) ? thread.messages.at(-1) : null
      if (!(threadLast?.role === 'assistant' && threadLast?.text === body && typeof threadLast?.time === 'number' && now - threadLast.time < 30_000)) {
        if (!Array.isArray(thread.messages)) thread.messages = []
        thread.messages.push(buildMsg())
        thread.lastActiveAt = now
        changed = true
      }
    }
  } catch { /* ignore thread push failure */ }

  if (changed) saveSessions(sessions)
}

async function notifyConnectorTaskFollowups(params: {
  task: BoardTask
  statusLabel: string
  summaryText: string
  imageUrl?: string
  mediaPath?: string
  mediaFileName?: string
}) {
  const { task, statusLabel, summaryText, imageUrl, mediaPath, mediaFileName } = params

  const connectors = loadConnectors()
  const running = (await import('./connectors/manager')).listRunningConnectors()
  const manager = await import('./connectors/manager')
  const sessions = loadSessions()

  const candidateByKey = new Map<string, ConnectorTaskFollowupTarget>()
  const addCandidate = (candidate: ConnectorTaskFollowupTarget | null | undefined) => {
    if (!candidate?.connectorId || !candidate?.channelId) return
    const key = `${candidate.connectorId}|${candidate.channelId}`
    if (!candidateByKey.has(key)) candidateByKey.set(key, candidate)
  }

  const originTarget = resolveTaskOriginConnectorFollowupTarget({
    task,
    sessions: sessions as Record<string, SessionLike>,
    connectors,
    running: running as RunningConnectorLike[],
  })
  addCandidate(originTarget)
  const preferredTargetKey = originTarget
    ? `${originTarget.connectorId}|${originTarget.channelId}`
    : ''

  for (const entry of running) {
    if (!entry.supportsSend || !entry.id) continue
    const connector = connectors[entry.id]
    if (!connector) continue
    if (connector.agentId !== task.agentId) continue
    if (!isEnabledFlag(connector.config?.taskFollowups)) continue
    const channelTargetRaw = entry.recentChannelId
      || entry.configuredTargets[0]
      || connector.config?.outboundJid
      || connector.config?.outboundTarget
      || ''
    if (!channelTargetRaw) continue
    addCandidate({
      connectorId: entry.id,
      channelId: connector.platform === 'whatsapp'
        ? normalizeWhatsappTarget(channelTargetRaw)
        : channelTargetRaw,
    })
  }
  const targets = [...candidateByKey.values()].sort((a, b) => {
    if (!preferredTargetKey) return 0
    const aKey = `${a.connectorId}|${a.channelId}`
    const bKey = `${b.connectorId}|${b.channelId}`
    if (aKey === preferredTargetKey && bKey !== preferredTargetKey) return -1
    if (bKey === preferredTargetKey && aKey !== preferredTargetKey) return 1
    return 0
  })
  if (!targets.length) return

  const summary = summaryText.trim().slice(0, 1400)
  for (const target of targets) {
    const connector = connectors[target.connectorId]
    if (!connector) continue

    const template = typeof connector.config?.taskFollowupTemplate === 'string'
      ? connector.config.taskFollowupTemplate.trim()
      : ''
    const message = template
      ? fillTaskFollowupTemplate(template, {
          status: statusLabel,
          title: task.title || task.id,
          summary,
          taskId: task.id,
        })
      : [
          `Task ${statusLabel}: ${task.title}`,
          summary || 'No summary provided.',
        ].join('\n\n')
    const targetKey = `${target.connectorId}|${target.channelId}`
    const preferredChannelNote = !template && preferredTargetKey && targetKey === preferredTargetKey
      ? '\n\n(Update sent in the same channel that requested this task.)'
      : ''
    const outboundMessage = `${message}${preferredChannelNote}`

    const resolvedMediaPath = mediaPath || maybeResolveUploadMediaPathFromUrl(imageUrl)
    try {
      await manager.sendConnectorMessage({
        connectorId: target.connectorId,
        channelId: target.channelId,
        text: outboundMessage,
        ...(resolvedMediaPath
          ? {
              mediaPath: resolvedMediaPath,
              fileName: mediaFileName || path.basename(resolvedMediaPath),
              caption: outboundMessage,
            }
          : {}),
      })
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.warn(`[queue] Failed task follow-up send on connector ${target.connectorId}: ${errMsg}`)
    }
  }
}

/**
 * Notify agent thread sessions when a task completes or fails.
 * - Always pushes to the executing agent's thread
 * - If delegated, also pushes to the delegating agent's thread
 */
function notifyAgentThreadTaskResult(task: BoardTask): void {
  if (task.status !== 'completed' && task.status !== 'failed') return

  const sessions = loadSessions()
  const agents = loadAgents()
  const agent = agents[task.agentId]

  const runSessionId = typeof task.sessionId === 'string' ? task.sessionId : ''
  const runSession = runSessionId ? sessions[runSessionId] : null
  const fallbackText = runSession ? latestAssistantText(runSession) : ''
  const taskResult = extractTaskResult(
    runSession,
    task.result || fallbackText || null,
    { sinceTime: typeof task.startedAt === 'number' ? task.startedAt : null },
  )
  const resultBody = formatResultBody(taskResult)
  const outputFileRefs = Array.isArray(task.outputFiles) && task.outputFiles.length > 0
    ? task.outputFiles
    : extractLikelyOutputFiles(resultBody)

  const statusLabel = task.status === 'completed' ? 'completed' : 'failed'
  const taskLink = `[${task.title}](#task:${task.id})`
  const firstImage = taskResult.artifacts.find((a) => a.type === 'image')
  const firstArtifactMediaPath = taskResult.artifacts
    .map((artifact) => maybeResolveUploadMediaPathFromUrl(artifact.url))
    .find((candidate): candidate is string => Boolean(candidate))
  const now = Date.now()
  let changed = false

  // Build CLI resume ID info lines
  const resumeLines: string[] = []
  if (task.claudeResumeId) resumeLines.push(`Claude session: \`${task.claudeResumeId}\``)
  if (task.codexResumeId) resumeLines.push(`Codex thread: \`${task.codexResumeId}\``)
  if (task.opencodeResumeId) resumeLines.push(`OpenCode session: \`${task.opencodeResumeId}\``)
  if (task.geminiResumeId) resumeLines.push(`Gemini session: \`${task.geminiResumeId}\``)
  // Fallback to legacy field
  if (resumeLines.length === 0 && task.cliResumeId) {
    resumeLines.push(`${task.cliProvider || 'CLI'} session: \`${task.cliResumeId}\``)
  }

  // Get working directory from execution session
  const execCwd = runSession?.cwd || ''
  const existingOutputPaths = outputFileRefs
    .map((fileRef) => resolveExistingOutputFilePath(fileRef, execCwd))
    .filter((candidate): candidate is string => Boolean(candidate))
  const firstLocalOutputPath = existingOutputPaths.find((candidate) => isSendableAttachment(candidate))
  const followupMediaPath = firstArtifactMediaPath || firstLocalOutputPath || undefined

  const buildMsg = (text: string): Message => {
    const msg: Message = { role: 'assistant', text, time: now, kind: 'system' }
    if (firstImage) msg.imageUrl = firstImage.url
    return msg
  }

  const buildResultBlock = (prefix: string): string => {
    const parts = [prefix]
    if (execCwd) parts.push(`Working directory: \`${execCwd}\``)
    if (outputFileRefs.length > 0) {
      parts.push(`Output files:\n${outputFileRefs.slice(0, 8).map((fileRef) => `- \`${fileRef}\``).join('\n')}`)
    }
    if (task.completionReportPath) parts.push(`Task report: \`${task.completionReportPath}\``)
    if (resumeLines.length > 0) parts.push(resumeLines.join(' | '))
    parts.push(resultBody || 'No summary.')
    return parts.join('\n\n')
  }

  // 1. Push to executing agent's thread
  if (agent?.threadSessionId && sessions[agent.threadSessionId]) {
    const thread = sessions[agent.threadSessionId]
    if (!Array.isArray(thread.messages)) thread.messages = []
    const body = buildResultBlock(`Task ${statusLabel}: **${taskLink}**`)
    thread.messages.push(buildMsg(body))
    thread.lastActiveAt = now
    changed = true
  }

  // 2. If delegated, push to delegating agent's thread AND active chat sessions
  const delegatedBy = (task as unknown as Record<string, unknown>).delegatedByAgentId
  if (typeof delegatedBy === 'string' && delegatedBy !== task.agentId) {
    const delegator = agents[delegatedBy]
    const agentName = agent?.name || task.agentId
    const delegationBody = buildResultBlock(`Delegated task ${statusLabel}: **${taskLink}** (by ${agentName})`)

    // Push to delegating agent's thread
    if (delegator?.threadSessionId && sessions[delegator.threadSessionId]) {
      const thread = sessions[delegator.threadSessionId]
      if (!Array.isArray(thread.messages)) thread.messages = []
      thread.messages.push(buildMsg(delegationBody))
      thread.lastActiveAt = now
      changed = true
    }

    // Push to delegating agent's active user-facing chat sessions
    // so the result is visible in the chat the user is looking at.
    if (delegator) {
      for (const session of Object.values(sessions)) {
        if (!session || session.agentId !== delegatedBy) continue
        // Skip the agent shortcut session itself.
        if (session.id === delegator.threadSessionId) continue
        // Only push to recently-active sessions (within last 30 minutes)
        const lastActive = typeof session.lastActiveAt === 'number' ? session.lastActiveAt : 0
        if (now - lastActive > 30 * 60_000) continue
        if (!Array.isArray(session.messages)) session.messages = []
        // Avoid duplicate push
        const lastMsg = session.messages.at(-1)
        if (lastMsg?.text === delegationBody && typeof lastMsg?.time === 'number' && now - lastMsg.time < 30_000) continue
        session.messages.push(buildMsg(delegationBody))
        session.lastActiveAt = now
        changed = true
        // Notify the specific session's message topic for real-time UI update
        notify(`messages:${session.id}`)
      }
    }
  }

  if (changed) saveSessions(sessions)

  void notifyConnectorTaskFollowups({
    task,
    statusLabel,
    summaryText: resultBody || '',
    imageUrl: firstImage?.url,
    mediaPath: followupMediaPath,
    mediaFileName: followupMediaPath ? path.basename(followupMediaPath) : undefined,
  })
}

/** Disable heartbeat on a task's session when the task finishes. */
export function disableSessionHeartbeat(sessionId: string | null | undefined) {
  if (!sessionId) return
  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session || session.heartbeatEnabled === false) return
  session.heartbeatEnabled = false
  session.lastActiveAt = Date.now()
  saveSessions(sessions)
  console.log(`[queue] Disabled heartbeat on session ${sessionId} (task finished)`)
}

export function enqueueTask(taskId: string) {
  const tasks = loadTasks()
  const task = tasks[taskId] as BoardTask | undefined
  if (!task) return

  applyTaskPolicyDefaults(task)
  task.status = 'queued'
  task.queuedAt = Date.now()
  task.retryScheduledAt = null
  task.updatedAt = Date.now()
  saveTasks(tasks)

  const queue = loadQueue()
  pushQueueUnique(queue, taskId)
  saveQueue(queue)

  pushMainLoopEventToMainSessions({
    type: 'task_queued',
    text: `Task queued: "${task.title}" (${task.id})`,
  })

  // If processNext is already running, mark a pending kick so it re-enters after finishing
  if (_queueState.processing) {
    _queueState.pendingKick = true
  }
  // Delay before kicking worker so UI shows the queued state
  setTimeout(() => processNext(), 2000)
}

/**
 * Re-validate all completed tasks so the completed queue only contains
 * tasks with concrete completion evidence.
 */
export function validateCompletedTasksQueue() {
  const tasks = loadTasks()
  const sessions = loadSessions()
  const settings = loadSettings()
  const now = Date.now()
  let checked = 0
  let demoted = 0
  let tasksDirty = false
  let sessionsDirty = false

  for (const task of Object.values(tasks) as BoardTask[]) {
    if (task.status !== 'completed') continue
    checked++

    const report = ensureTaskCompletionReport(task)
    if (report?.relativePath && task.completionReportPath !== report.relativePath) {
      task.completionReportPath = report.relativePath
      tasksDirty = true
    }

    const validation = validateTaskCompletion(task, { report, settings })
    const prevValidation = task.validation || null
    const validationChanged = !prevValidation
      || prevValidation.ok !== validation.ok
      || !sameReasons(prevValidation.reasons, validation.reasons)

    if (validationChanged) {
      task.validation = validation
      tasksDirty = true
    }

    if (validation.ok) {
      if (!task.completedAt) {
        task.completedAt = now
        task.updatedAt = now
        tasksDirty = true
      }
      continue
    }

    task.status = 'failed'
    task.completedAt = null
    task.error = formatValidationFailure(validation.reasons).slice(0, 500)
    task.updatedAt = now
    if (!task.comments) task.comments = []
    task.comments.push({
      id: genId(),
      author: 'System',
      text: `Task auto-failed completed-queue validation.\n\n${validation.reasons.map((r) => `- ${r}`).join('\n')}`,
      createdAt: now,
    })
    tasksDirty = true
    demoted++

    if (task.sessionId) {
      const session = sessions[task.sessionId]
      if (session && session.heartbeatEnabled !== false) {
        session.heartbeatEnabled = false
        session.lastActiveAt = now
        sessionsDirty = true
      }
    }
  }

  if (tasksDirty) { saveTasks(tasks); notify('tasks') }
  if (sessionsDirty) saveSessions(sessions)
  if (demoted > 0) {
    console.warn(`[queue] Demoted ${demoted} invalid completed task(s) to failed after validation audit`)
  }
  return { checked, demoted }
}

function scheduleRetryOrDeadLetter(task: BoardTask, reason: string): 'retry' | 'dead_lettered' {
  applyTaskPolicyDefaults(task)
  const now = Date.now()
  task.attempts = (task.attempts || 0) + 1

  if ((task.attempts || 0) < (task.maxAttempts || 1)) {
    const delaySec = Math.min(6 * 3600, (task.retryBackoffSec || 30) * (2 ** Math.max(0, (task.attempts || 1) - 1)))
    task.status = 'queued'
    task.retryScheduledAt = now + delaySec * 1000
    task.updatedAt = now
    task.error = `Retry scheduled after failure: ${reason}`.slice(0, 500)
    if (!task.comments) task.comments = []
    task.comments.push({
      id: genId(),
      author: 'System',
      text: `Attempt ${task.attempts}/${task.maxAttempts} failed. Retrying in ${delaySec}s.\n\nReason: ${reason}`,
      createdAt: now,
    })
    return 'retry'
  }

  task.status = 'failed'
  task.deadLetteredAt = now
  task.retryScheduledAt = null
  task.updatedAt = now
  task.error = `Dead-lettered after ${task.attempts}/${task.maxAttempts} attempts: ${reason}`.slice(0, 500)
  if (!task.comments) task.comments = []
  task.comments.push({
    id: genId(),
    author: 'System',
    text: `Task moved to dead-letter after ${task.attempts}/${task.maxAttempts} attempts.\n\nReason: ${reason}`,
    createdAt: now,
  })

  // Guardian Auto-Rollback
  const agents = loadAgents()
  const agent = task.agentId ? agents[task.agentId] : null
  if (agent?.autoRecovery) {
    const cwd = task.projectId 
      ? path.join(WORKSPACE_DIR, 'projects', task.projectId) 
      : WORKSPACE_DIR
    const rollback = performGuardianRollback(cwd)
    if (rollback.ok) {
      task.comments.push({
        id: genId(),
        author: 'Guardian',
        text: `Auto-recovery triggered: Workspace successfully rolled back to last clean state.`,
        createdAt: now + 1,
      })
    } else {
      task.comments.push({
        id: genId(),
        author: 'Guardian',
        text: `Auto-recovery failed: ${rollback.reason}`,
        createdAt: now + 1,
      })
    }
  }

  return 'dead_lettered'
}

export function dequeueNextRunnableTask(queue: string[], tasks: Record<string, BoardTask>): string | null {
  const now = Date.now()

  // Remove stale entries first.
  for (let i = queue.length - 1; i >= 0; i--) {
    const id = queue[i]
    const task = tasks[id]
    if (!task || task.status !== 'queued') queue.splice(i, 1)
  }

  const idx = queue.findIndex((id) => {
    const task = tasks[id]
    if (!task) return false
    const retryAt = typeof task.retryScheduledAt === 'number' ? task.retryScheduledAt : null
    if (retryAt && retryAt > now) return false
    const blockers = Array.isArray(task.blockedBy) ? task.blockedBy : []
    return blockers.every((blockerId) => tasks[blockerId]?.status === 'completed')
  })
  if (idx === -1) return null
  const [taskId] = queue.splice(idx, 1)
  return taskId || null
}

export async function processNext() {
  if (_queueState.processing) return
  _queueState.processing = true

  try {
    // Recover orphaned tasks: status is 'queued' but missing from the queue array
    {
      const allTasks = loadTasks()
      const currentQueue = loadQueue()
      const queueSet = new Set(currentQueue)
      let recovered = false
      for (const [id, t] of Object.entries(allTasks) as [string, BoardTask][]) {
        if (t.status === 'queued' && !queueSet.has(id)) {
          console.log(`[queue] Recovering orphaned queued task: "${t.title}" (${id})`)
          pushQueueUnique(currentQueue, id)
          recovered = true
        }
      }
      if (recovered) saveQueue(currentQueue)
    }

    while (true) {
      const tasks = loadTasks()
      const queue = loadQueue()
      if (queue.length === 0) break

      const taskId = dequeueNextRunnableTask(queue, tasks as Record<string, BoardTask>)
      saveQueue(queue)
      if (!taskId) break
      const task = tasks[taskId] as BoardTask | undefined

      if (!task || task.status !== 'queued') {
        continue
      }

      // Dependency guard: skip tasks whose blockers are not all completed
      const blockers = Array.isArray(task.blockedBy) ? task.blockedBy as string[] : []
      if (blockers.length > 0) {
        const allBlockersDone = blockers.every((bid) => {
          const blocker = tasks[bid] as BoardTask | undefined
          return blocker?.status === 'completed'
        })
        if (!allBlockersDone) {
          // Put it back in the queue and skip
          pushQueueUnique(queue, taskId)
          saveQueue(queue)
          console.log(`[queue] Skipping task "${task.title}" (${taskId}) — blocked by incomplete dependencies`)
          continue
        }
      }

      const agents = loadAgents()
      const agent = agents[task.agentId]
      if (!agent) {
        task.status = 'failed'
        task.deadLetteredAt = Date.now()
        task.error = `Agent ${task.agentId} not found`
        task.updatedAt = Date.now()
        saveTasks(tasks)
        pushMainLoopEventToMainSessions({
          type: 'task_failed',
          text: `Task failed: "${task.title}" (${task.id}) — agent not found.`,
        })
        continue
      }

      // Mark as running
      applyTaskPolicyDefaults(task)
      task.status = 'running'
      task.startedAt = Date.now()
      task.retryScheduledAt = null
      task.deadLetteredAt = null
      // Clear transient failure fields so validation/error state reflects only this attempt.
      task.error = null
      task.validation = null
      task.updatedAt = Date.now()

      const sessionsForCwd = loadSessions() as Record<string, SessionLike>
      const taskCwd = resolveTaskExecutionCwd(task as ScheduleTaskMeta, sessionsForCwd)
      task.cwd = taskCwd
      let sessionId = ''
      const scheduleTask = task as ScheduleTaskMeta
      const isScheduleTask = scheduleTask.sourceType === 'schedule'
      const sourceScheduleId = typeof scheduleTask.sourceScheduleId === 'string'
        ? scheduleTask.sourceScheduleId
        : ''
      const reusableTaskSessionId = resolveReusableTaskSessionId(task, tasks as Record<string, BoardTask>, sessionsForCwd)
      const resumeContext = resolveTaskResumeContext(task, tasks as Record<string, BoardTask>, sessionsForCwd as Record<string, SessionLike | Session>)

      // Resolve the agent's persistent thread session to use as parentSessionId
      const agentThreadSessionId = agent.threadSessionId || null
      const taskRoutePreferences = deriveTaskRoutePreferences(task)

      if (isScheduleTask && sourceScheduleId) {
        const schedules = loadSchedules()
        const linkedSchedule = schedules[sourceScheduleId]
        const existingSessionId = typeof linkedSchedule?.lastSessionId === 'string'
          ? linkedSchedule.lastSessionId
          : ''
        if (existingSessionId) {
          const sessions = loadSessions()
          if (sessions[existingSessionId]) {
            sessionId = existingSessionId
          }
        }
        if (!sessionId) {
          sessionId = createOrchestratorSession(
            agent,
            task.title,
            agentThreadSessionId || undefined,
            taskCwd,
            taskRoutePreferences,
          )
        }
        if (linkedSchedule && linkedSchedule.lastSessionId !== sessionId) {
          linkedSchedule.lastSessionId = sessionId
          linkedSchedule.updatedAt = Date.now()
          schedules[sourceScheduleId] = linkedSchedule
          saveSchedules(schedules)
        }
      } else {
        sessionId = reusableTaskSessionId || createOrchestratorSession(
          agent,
          task.title,
          agentThreadSessionId || undefined,
          taskCwd,
          taskRoutePreferences,
        )
      }

      const executionSessions = loadSessions() as Record<string, Session>
      const executionSession = executionSessions[sessionId]
      const seededResumeState = executionSession
        ? applyTaskResumeStateToSession(executionSession, resumeContext?.resume)
        : false
      if (seededResumeState) saveSessions(executionSessions)

      // Notify the agent's thread that a task has started
      if (agentThreadSessionId) {
        try {
          const threadSessions = loadSessions()
          const thread = threadSessions[agentThreadSessionId]
          if (thread) {
            if (!Array.isArray(thread.messages)) thread.messages = []
            const scheduleTask2 = task as ScheduleTaskMeta
            const schedId = typeof scheduleTask2.sourceScheduleId === 'string' ? scheduleTask2.sourceScheduleId : ''
            const runLabel = task.runNumber ? ` (run #${task.runNumber})` : ''
            const taskLink = `[${task.title}](#task:${task.id})`
            const schedLink = schedId ? ` | [Schedule](#schedule:${schedId})` : ''
            thread.messages.push({
              role: 'assistant',
              text: `Started task: **${taskLink}**${runLabel}${schedLink}`,
              time: Date.now(),
              kind: 'system',
            })
            thread.lastActiveAt = Date.now()
            saveSessions(threadSessions)
          }
        } catch { /* ignore thread notification failure */ }
      }

      task.sessionId = sessionId
      const reusedExistingSession = !isScheduleTask && Boolean(reusableTaskSessionId) && reusableTaskSessionId === sessionId
      const continuationBits: string[] = []
      if (reusedExistingSession) {
        continuationBits.push('reusing prior session')
      }
      if (resumeContext?.source === 'delegated_from_task' || resumeContext?.source === 'blocked_by') {
        continuationBits.push(`seeded from task ${resumeContext.sourceTaskId}`)
      } else if (seededResumeState) {
        continuationBits.push('restored CLI resume handles')
      }
      task.checkpoint = {
        lastSessionId: sessionId,
        note: `Attempt ${(task.attempts || 0) + 1}/${task.maxAttempts || '?'} started${continuationBits.length ? ` (${continuationBits.join('; ')})` : ''}`,
        updatedAt: Date.now(),
      }
      saveTasks(tasks)
      pushMainLoopEventToMainSessions({
        type: 'task_running',
        text: `Task running: "${task.title}" (${task.id}) with ${agent.name}`,
      })

      // Save initial assistant message so user sees context when opening the session
      const sessions = loadSessions()
      if (sessions[sessionId]) {
        const isDelegation = (task as unknown as Record<string, unknown>).sourceType === 'delegation'
        let initialText: string
        if (isDelegation) {
          const delegatorId = (task as unknown as Record<string, unknown>).delegatedByAgentId as string | undefined
          const delegator = delegatorId ? agents[delegatorId] : null
          const prefix = `[delegation-source:${delegatorId || ''}:${delegator?.name || 'Agent'}:${delegator?.avatarSeed || ''}]`
          initialText = `${prefix}\nDelegated by **${delegator?.name || 'another agent'}** | [${task.title}](#task:${task.id})\n\n${task.description || ''}\n\nWorking directory: \`${taskCwd}\`${buildTaskContinuationNote(Boolean(reusedExistingSession), resumeContext)}\n\nI'll begin working on this now.`
        } else {
          initialText = `Starting task: **${task.title}**\n\n${task.description || ''}\n\nWorking directory: \`${taskCwd}\`${buildTaskContinuationNote(Boolean(reusedExistingSession), resumeContext)}\n\nI'll begin working on this now.`
        }
        sessions[sessionId].messages.push({
          role: 'assistant',
          text: initialText,
          time: Date.now(),
          ...(isDelegation ? { kind: 'system' as const } : {}),
        })
        saveSessions(sessions)
      }

      console.log(`[queue] Running task "${task.title}" (${taskId}) with ${agent.name}`)

      try {
        const result = await executeTaskRun(task, agent, sessionId)
        const t2 = loadTasks()
        const settings = loadSettings()
        if (t2[taskId]) {
          applyTaskPolicyDefaults(t2[taskId])
          // Structured extraction: Zod-validated result with typed artifacts
          const runSessions = loadSessions()
          const taskResult = extractTaskResult(
            runSessions[sessionId],
            result || null,
            { sinceTime: typeof t2[taskId].startedAt === 'number' ? t2[taskId].startedAt : null },
          )
          const enrichedResult = formatResultBody(taskResult)
          t2[taskId].result = enrichedResult.slice(0, 4000) || null
          t2[taskId].artifacts = taskResult.artifacts.slice(0, 24)
          t2[taskId].outputFiles = extractLikelyOutputFiles(enrichedResult).slice(0, 24)
          t2[taskId].updatedAt = Date.now()
          const report = ensureTaskCompletionReport(t2[taskId])
          if (report?.relativePath) t2[taskId].completionReportPath = report.relativePath
          const validation = validateTaskCompletion(t2[taskId], { report, settings })
          t2[taskId].validation = validation

          const now = Date.now()
          // Add a completion/failure comment from the orchestrator.
          if (!t2[taskId].comments) t2[taskId].comments = []

          if (validation.ok) {
            t2[taskId].status = 'completed'
            t2[taskId].completedAt = now
            t2[taskId].retryScheduledAt = null
            t2[taskId].error = null
            t2[taskId].checkpoint = {
              ...(t2[taskId].checkpoint || {}),
              lastRunId: sessionId,
              lastSessionId: sessionId,
              note: `Completed on attempt ${t2[taskId].attempts || 0}/${t2[taskId].maxAttempts || '?'}`,
              updatedAt: now,
            }
            t2[taskId].comments!.push({
              id: genId(),
              author: agent.name,
              agentId: agent.id,
              text: `Task completed.\n\n${result?.slice(0, 1000) || 'No summary provided.'}`,
              createdAt: now,
            })
          } else {
            const failureReason = formatValidationFailure(validation.reasons).slice(0, 500)
            const retryState = scheduleRetryOrDeadLetter(t2[taskId], failureReason)
            t2[taskId].completedAt = retryState === 'dead_lettered' ? null : t2[taskId].completedAt
            t2[taskId].comments!.push({
              id: genId(),
              author: agent.name,
              agentId: agent.id,
              text: `Task failed validation and was not marked completed.\n\n${validation.reasons.map((r) => `- ${r}`).join('\n')}`,
              createdAt: now,
            })
            if (retryState === 'retry') {
              const qRetry = loadQueue()
              pushQueueUnique(qRetry, taskId)
              saveQueue(qRetry)
              pushMainLoopEventToMainSessions({
                type: 'task_retry_scheduled',
                text: `Task retry scheduled: "${task.title}" (${taskId}) attempt ${t2[taskId].attempts}/${t2[taskId].maxAttempts} in ${t2[taskId].retryBackoffSec}s.`,
              })
            }
          }

          // Copy ALL CLI resume IDs from the execution session to the task record
          try {
            const execSessions = loadSessions()
            const execSession = execSessions[sessionId] as Record<string, unknown> | undefined
            if (execSession) {
              const delegateIds = execSession.delegateResumeIds as
                | { claudeCode?: string | null; codex?: string | null; opencode?: string | null; gemini?: string | null }
                | undefined
              // Store each CLI resume ID separately
              const claudeId = (execSession.claudeSessionId as string) || delegateIds?.claudeCode || null
              const codexId = (execSession.codexThreadId as string) || delegateIds?.codex || null
              const opencodeId = (execSession.opencodeSessionId as string) || delegateIds?.opencode || null
              const geminiId = delegateIds?.gemini || null
              if (claudeId) t2[taskId].claudeResumeId = claudeId
              if (codexId) t2[taskId].codexResumeId = codexId
              if (opencodeId) t2[taskId].opencodeResumeId = opencodeId
              if (geminiId) t2[taskId].geminiResumeId = geminiId
              // Keep backward-compat single field (first available)
              const primaryId = claudeId || codexId || opencodeId || geminiId
              if (primaryId) {
                t2[taskId].cliResumeId = primaryId
                if (claudeId) t2[taskId].cliProvider = 'claude-cli'
                else if (codexId) t2[taskId].cliProvider = 'codex-cli'
                else if (opencodeId) t2[taskId].cliProvider = 'opencode-cli'
                else if (geminiId) t2[taskId].cliProvider = 'gemini-cli'
              }
              console.log(`[queue] CLI resume IDs for task ${taskId}: claude=${claudeId}, codex=${codexId}, opencode=${opencodeId}, gemini=${geminiId}`)
            }
          } catch (e) {
            console.warn(`[queue] Failed to extract CLI resume IDs for task ${taskId}:`, e)
          }

          saveTasks(t2)
          notify('tasks')
          notify('runs')
          disableSessionHeartbeat(t2[taskId].sessionId)
        }
        const doneTask = t2[taskId]
        if (doneTask?.status === 'completed') {
          pushMainLoopEventToMainSessions({
            type: 'task_completed',
            text: `Task completed: "${task.title}" (${taskId})`,
          })
          notifyMainChatScheduleResult(doneTask)
          notifyAgentThreadTaskResult(doneTask)
          // Clean up LangGraph checkpoints for completed tasks
          getCheckpointSaver().deleteThread(taskId).catch((e) =>
            console.warn(`[queue] Failed to clean up checkpoints for task ${taskId}:`, e)
          )
          // Cascade unblock: auto-queue tasks whose blockers are all done
          const latestTasks = loadTasks()
          const unblockedIds = cascadeUnblock(latestTasks, taskId)
          if (unblockedIds.length > 0) {
            saveTasks(latestTasks)
            for (const uid of unblockedIds) {
              enqueueTask(uid)
              console.log(`[queue] Auto-unblocked task "${latestTasks[uid]?.title}" (${uid})`)
            }
            notify('tasks')
          }
          console.log(`[queue] Task "${task.title}" completed`)
        } else {
          if (doneTask?.status === 'queued') {
            console.warn(`[queue] Task "${task.title}" scheduled for retry`)
          } else {
            pushMainLoopEventToMainSessions({
              type: 'task_failed',
              text: `Task failed validation: "${task.title}" (${taskId})`,
            })
            if (doneTask?.status === 'failed') {
              notifyMainChatScheduleResult(doneTask)
              notifyAgentThreadTaskResult(doneTask)
            }
            console.warn(`[queue] Task "${task.title}" failed completion validation`)
          }
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err || 'Unknown error')
        console.error(`[queue] Task "${task.title}" failed:`, errMsg)
        const t2 = loadTasks()
        if (t2[taskId]) {
          applyTaskPolicyDefaults(t2[taskId])
          const retryState = scheduleRetryOrDeadLetter(t2[taskId], errMsg.slice(0, 500) || 'Unknown error')
          if (!t2[taskId].comments) t2[taskId].comments = []
          // Only add a failure comment if the last comment isn't already an error comment
          const lastComment = t2[taskId].comments!.at(-1)
          const isRepeatError = lastComment?.agentId === agent.id && lastComment?.text.startsWith('Task failed')
          if (!isRepeatError) {
            t2[taskId].comments!.push({
              id: genId(),
              author: agent.name,
              agentId: agent.id,
              text: 'Task failed — see error details above.',
              createdAt: Date.now(),
            })
          }
          saveTasks(t2)
          notify('tasks')
          notify('runs')
          disableSessionHeartbeat(t2[taskId].sessionId)
          if (retryState === 'retry') {
            const qRetry = loadQueue()
            pushQueueUnique(qRetry, taskId)
            saveQueue(qRetry)
            pushMainLoopEventToMainSessions({
              type: 'task_retry_scheduled',
              text: `Task retry scheduled: "${task.title}" (${taskId}) attempt ${t2[taskId].attempts}/${t2[taskId].maxAttempts}.`,
            })
          }
        }
        const latest = loadTasks()[taskId] as BoardTask | undefined
        if (latest?.status === 'queued') {
          console.warn(`[queue] Task "${task.title}" queued for retry after error`)
        } else {
          pushMainLoopEventToMainSessions({
            type: 'task_failed',
            text: `Task failed: "${task.title}" (${taskId}) — ${errMsg.slice(0, 200)}`,
          })
          if (latest?.status === 'failed') {
            notifyMainChatScheduleResult(latest)
            notifyAgentThreadTaskResult(latest)
          }
        }
      }
    }
  } finally {
    _queueState.processing = false
    // If tasks were enqueued while we were processing, kick another round
    if (_queueState.pendingKick) {
      _queueState.pendingKick = false
      setTimeout(() => processNext(), 500)
    }
  }
}

/** On boot, disable heartbeat on sessions whose tasks are already completed/failed. */
export function cleanupFinishedTaskSessions() {
  const tasks = loadTasks()
  const sessions = loadSessions()
  let cleaned = 0
  for (const task of Object.values(tasks) as BoardTask[]) {
    if ((task.status === 'completed' || task.status === 'failed') && task.sessionId) {
      const session = sessions[task.sessionId]
      if (session && session.heartbeatEnabled !== false) {
        session.heartbeatEnabled = false
        session.lastActiveAt = Date.now()
        cleaned++
      }
    }
  }
  if (cleaned > 0) {
    saveSessions(sessions)
    console.log(`[queue] Disabled heartbeat on ${cleaned} session(s) with finished tasks`)
  }
}

/** Recover running tasks that appear stalled and requeue/dead-letter them per retry policy. */
export function recoverStalledRunningTasks(): { recovered: number; deadLettered: number } {
  const settings = loadSettings()
  const stallTimeoutMin = normalizeInt(settings.taskStallTimeoutMin, 45, 5, 24 * 60)
  const staleMs = stallTimeoutMin * 60_000
  const now = Date.now()
  const tasks = loadTasks()
  const queue = loadQueue()
  let recovered = 0
  let deadLettered = 0
  let changed = false

  for (const task of Object.values(tasks) as BoardTask[]) {
    if (task.status !== 'running') continue
    if (!task.startedAt) {
      const recoveredAt = Date.now()
      task.status = 'queued'
      task.queuedAt = task.queuedAt || recoveredAt
      task.retryScheduledAt = null
      task.updatedAt = recoveredAt
      task.error = 'Recovered inconsistent running state (missing startedAt); requeued.'
      if (!task.comments) task.comments = []
      task.comments.push({
        id: genId(),
        author: 'System',
        text: 'Recovered inconsistent running state (missing startedAt). Task requeued.',
        createdAt: recoveredAt,
      })
      pushQueueUnique(queue, task.id)
      recovered++
      changed = true
      pushMainLoopEventToMainSessions({
        type: 'task_stall_recovered',
        text: `Recovered inconsistent running task "${task.title}" (${task.id}) and requeued it.`,
      })
      continue
    }
    const since = Math.max(task.updatedAt || 0, task.startedAt || 0)
    if (!since || (now - since) < staleMs) continue

    const reason = `Detected stalled run after ${stallTimeoutMin}m without progress`
    const state = scheduleRetryOrDeadLetter(task, reason)
    disableSessionHeartbeat(task.sessionId)
    changed = true
    if (state === 'retry') {
      pushQueueUnique(queue, task.id)
      recovered++
      pushMainLoopEventToMainSessions({
        type: 'task_stall_recovered',
        text: `Recovered stalled task "${task.title}" (${task.id}) and requeued attempt ${task.attempts}/${task.maxAttempts}.`,
      })
    } else {
      deadLettered++
      pushMainLoopEventToMainSessions({
        type: 'task_dead_lettered',
        text: `Task dead-lettered after stalling: "${task.title}" (${task.id}).`,
      })
    }
  }

  if (changed) {
    saveTasks(tasks)
    saveQueue(queue)
    if (recovered > 0) {
      setTimeout(() => processNext(), 250)
    }
  }

  return { recovered, deadLettered }
}

/** Resume any queued tasks on server boot */
export function resumeQueue() {
  // Check for tasks stuck in 'queued' status but not in the queue array
  const tasks = loadTasks()
  const queue = loadQueue()
  let modified = false
  for (const task of Object.values(tasks) as BoardTask[]) {
    if (task.status === 'queued' && !queue.includes(task.id)) {
      applyTaskPolicyDefaults(task)
      console.log(`[queue] Recovering stuck queued task: "${task.title}" (${task.id})`)
      queue.push(task.id)
      task.queuedAt = task.queuedAt || Date.now()
      modified = true
    }
  }
  if (modified) {
    saveQueue(queue)
    saveTasks(tasks)
  }

  if (queue.length > 0) {
    console.log(`[queue] Resuming ${queue.length} queued task(s) on boot`)
    processNext()
  }
}
