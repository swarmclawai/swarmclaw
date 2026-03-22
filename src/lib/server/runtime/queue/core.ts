import { log } from '@/lib/server/logger'
import { matchesCapabilities, filterAgentsByCapabilities, capabilityMatchScore } from '@/lib/server/agents/capability-match'
import { genId } from '@/lib/id'
import { dedup, hmrSingleton, jitteredBackoff } from '@/lib/shared-utils'
import fs from 'node:fs'
import path from 'node:path'
import { logActivity } from '@/lib/server/activity/activity-log'
import { loadAgents } from '@/lib/server/agents/agent-repository'
import { withTransaction } from '@/lib/server/persistence/transaction'
import { loadQueue, saveQueue } from '@/lib/server/runtime/queue-repository'
import { loadSchedules, saveSchedules } from '@/lib/server/schedules/schedule-repository'
import { loadSessions, saveSessions } from '@/lib/server/sessions/session-repository'
import { loadSettings } from '@/lib/server/settings/settings-repository'
import { loadTasks, saveTasks } from '@/lib/server/tasks/task-repository'
import { notify } from '@/lib/server/ws-hub'
import { getMessages, getLastMessage, appendMessage } from '@/lib/server/messages/message-repository'
import { perf } from '@/lib/server/runtime/perf'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { createAgentTaskSession } from '@/lib/server/agents/task-session'
import { formatValidationFailure } from '@/lib/server/tasks/task-validation'
import { pushMainLoopEventToMainSessions } from '@/lib/server/agents/main-agent-loop'
import type { ExecuteChatTurnResult } from '@/lib/server/chat-execution/chat-execution-types'
import { checkAgentBudgetLimits } from '@/lib/server/cost'
import { enqueueExecution } from '@/lib/server/execution-engine'
import { extractTaskResult, formatResultBody } from '@/lib/server/tasks/task-result'
import {
  classifyRuntimeFailure,
  observeAutonomyRunOutcome,
  recordSupervisorIncident,
} from '@/lib/server/autonomy/supervisor-reflection'
import {
  collectTaskConnectorFollowupTargets as collectTaskConnectorFollowupTargetsImpl,
  extractLikelyOutputFiles,
  isSendableAttachment,
  maybeResolveUploadMediaPathFromUrl,
  notifyConnectorTaskFollowups,
  resolveExistingOutputFilePath,
  resolveTaskOriginConnectorFollowupTarget as resolveTaskOriginConnectorFollowupTargetImpl,
  type ScheduleTaskMeta,
  type SessionLike,
} from '@/lib/server/tasks/task-followups'
import { getCheckpointSaver } from '@/lib/server/langgraph-checkpoint'
import { cascadeUnblock } from '@/lib/server/dag-validation'
import { prepareGuardianRecovery } from '@/lib/server/agents/guardian'
import { notifyOrchestrators } from '@/lib/server/runtime/orchestrator-events'
import type { Agent, BoardTask, Message, Session } from '@/types'
import { buildAgentDisabledMessage, isAgentDisabled } from '@/lib/server/agents/agent-availability'
import {
  didTaskValidationChange,
  markInvalidCompletedTaskFailed,
  markValidatedTaskCompleted,
  refreshTaskCompletionValidation,
} from '@/lib/server/tasks/task-lifecycle'
import { noteMissionTaskFinished, noteMissionTaskStarted } from '@/lib/server/missions/mission-service'

const TAG = 'queue'

export const collectTaskConnectorFollowupTargets = collectTaskConnectorFollowupTargetsImpl
export const resolveTaskOriginConnectorFollowupTarget = resolveTaskOriginConnectorFollowupTargetImpl

// HMR-safe: pin processing state to globalThis so hot reloads don't reset it
const _queueState = hmrSingleton('__swarmclaw_queue__', () => ({
  activeCount: 0,
  maxConcurrent: 3,
  pendingKick: false,
}))

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
    ? dedup(task.tags.map((tag) => (typeof tag === 'string' ? tag.trim().toLowerCase() : '')).filter(Boolean))
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

function isCancelledTask(task: Partial<BoardTask> | null | undefined): boolean {
  return task?.status === 'cancelled'
}

function pushQueueUnique(queue: string[], id: string): void {
  if (!queueContains(queue, id)) queue.push(id)
}

function isAgentCreatedTask(task: Partial<BoardTask> | null | undefined): boolean {
  return Boolean(typeof task?.createdByAgentId === 'string' && task.createdByAgentId.trim())
}

function resolveTaskTerminalChatSessionId(
  task: BoardTask,
  sessions: Record<string, SessionLike>,
): string | null {
  if (task.status !== 'completed' && task.status !== 'failed') return null
  if (task.sourceType === 'schedule') return null
  if (isAgentCreatedTask(task)) return null
  const createdInSessionId = typeof task.createdInSessionId === 'string'
    ? task.createdInSessionId.trim()
    : ''
  return createdInSessionId && sessions[createdInSessionId] ? createdInSessionId : null
}

interface TaskResultDeliveryData {
  statusLabel: 'completed' | 'failed'
  resultBody: string
  outputFileRefs: string[]
  firstImage?: NonNullable<BoardTask['artifacts']>[number]
  followupMediaPath?: string
  mediaFileName?: string
  execCwd: string
  resumeLines: string[]
}

function collectTaskResultDeliveryData(
  task: BoardTask,
  sessions: Record<string, SessionLike>,
): TaskResultDeliveryData {
  const runSessionId = typeof task.sessionId === 'string' ? task.sessionId : ''
  const runSession = runSessionId ? sessions[runSessionId] : null
  const fallbackText = runSessionId ? latestAssistantText(runSessionId) : ''
  const taskResult = extractTaskResult(
    runSessionId ? getMessages(runSessionId) : [],
    task.result || fallbackText || null,
    { sinceTime: typeof task.startedAt === 'number' ? task.startedAt : null },
  )
  const resultBody = formatResultBody(taskResult)
  const outputFileRefs = Array.isArray(task.outputFiles) && task.outputFiles.length > 0
    ? task.outputFiles
    : extractLikelyOutputFiles(resultBody)
  const firstImage = taskResult.artifacts.find((artifact) => artifact.type === 'image')
  const firstArtifactMediaPath = taskResult.artifacts
    .map((artifact) => maybeResolveUploadMediaPathFromUrl(artifact.url))
    .find((candidate): candidate is string => Boolean(candidate))
  const resumeLines: string[] = []
  if (task.claudeResumeId) resumeLines.push(`Claude session: \`${task.claudeResumeId}\``)
  if (task.codexResumeId) resumeLines.push(`Codex thread: \`${task.codexResumeId}\``)
  if (task.opencodeResumeId) resumeLines.push(`OpenCode session: \`${task.opencodeResumeId}\``)
  if (task.geminiResumeId) resumeLines.push(`Gemini session: \`${task.geminiResumeId}\``)
  if (resumeLines.length === 0 && task.cliResumeId) {
    resumeLines.push(`${task.cliProvider || 'CLI'} session: \`${task.cliResumeId}\``)
  }
  const execCwd = runSession?.cwd || ''
  const existingOutputPaths = outputFileRefs
    .map((fileRef: string) => resolveExistingOutputFilePath(fileRef, execCwd))
    .filter((candidate: string | null): candidate is string => Boolean(candidate))
  const firstLocalOutputPath = existingOutputPaths.find((candidate: string) => isSendableAttachment(candidate))
  const followupMediaPath = firstArtifactMediaPath || firstLocalOutputPath || undefined

  return {
    statusLabel: task.status === 'completed' ? 'completed' : 'failed',
    resultBody,
    outputFileRefs,
    firstImage,
    followupMediaPath,
    mediaFileName: followupMediaPath ? path.basename(followupMediaPath) : undefined,
    execCwd,
    resumeLines,
  }
}

function buildTaskTerminalMessage(
  prefix: string,
  task: BoardTask,
  delivery: TaskResultDeliveryData,
): string {
  const parts = [prefix]
  if (delivery.execCwd) parts.push(`Working directory: \`${delivery.execCwd}\``)
  if (delivery.outputFileRefs.length > 0) {
    parts.push(`Output files:\n${delivery.outputFileRefs.slice(0, 8).map((fileRef: string) => `- \`${fileRef}\``).join('\n')}`)
  }
  if (task.completionReportPath) parts.push(`Task report: \`${task.completionReportPath}\``)
  if (delivery.resumeLines.length > 0) parts.push(delivery.resumeLines.join(' | '))
  parts.push(delivery.resultBody || 'No summary.')
  return parts.join('\n\n')
}

function latestAssistantText(sessionId: string | null | undefined): string {
  if (!sessionId) return ''
  const messages = getMessages(sessionId)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== 'assistant') continue
    const text = typeof msg?.text === 'string' ? msg.text.trim() : ''
    if (!text) continue
    if (/^HEARTBEAT_OK$/i.test(text)) continue
    return text
  }
  return ''
}

function queueTaskAutonomyObservation(input: {
  runId: string
  sessionId: string
  taskId: string
  agentId: string
  status: 'completed' | 'failed' | 'cancelled'
  resultText?: string | null
  error?: string | null
  toolEvents?: ExecuteChatTurnResult['toolEvents']
  sourceMessage?: string | null
}) {
  void observeAutonomyRunOutcome({
    runId: input.runId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    agentId: input.agentId,
    source: 'task',
    status: input.status,
    resultText: input.resultText,
    error: input.error || undefined,
    toolEvents: input.toolEvents,
    sourceMessage: input.sourceMessage,
  }).catch((err: unknown) => {
    log.warn(TAG, `[queue] Autonomy observation failed for ${input.runId}:`, err)
  })
}

function hasFinishedExecutionSession(session: SessionLike | Session | null | undefined): boolean {
  if (!session) return false
  return session.active === false && !session.currentRunId
}

export function reconcileFinishedRunningTasks(): { reconciled: number; deadLettered: number } {
  const tasks = loadTasks()
  const sessions = loadSessions() as Record<string, SessionLike>
  const settings = loadSettings()
  const queue = loadQueue()
  const now = Date.now()
  let reconciled = 0
  let deadLettered = 0
  let tasksDirty = false
  let sessionsDirty = false
  let queueDirty = false
  const terminalTasks: BoardTask[] = []

  for (const task of Object.values(tasks) as BoardTask[]) {
    if (task.status !== 'running') continue
    const sessionId = typeof task.sessionId === 'string' ? task.sessionId : ''
    if (!sessionId) continue
    const session = sessions[sessionId]
    if (!hasFinishedExecutionSession(session)) continue

    const fallbackText = latestAssistantText(sessionId)
    if (!fallbackText && !task.result) {
      task.status = 'failed'
      task.result = 'Agent session finished without producing output.'
      task.updatedAt = now
      tasksDirty = true
      continue
    }

    applyTaskPolicyDefaults(task)
    const taskResult = extractTaskResult(
      getMessages(sessionId),
      task.result || fallbackText || null,
      { sinceTime: typeof task.startedAt === 'number' ? task.startedAt : null },
    )
    const enrichedResult = formatResultBody(taskResult)
    task.result = enrichedResult.slice(0, 4000) || null
    task.artifacts = taskResult.artifacts.slice(0, 24)
    task.outputFiles = extractLikelyOutputFiles(enrichedResult).slice(0, 24)
    task.updatedAt = now
    const { validation } = refreshTaskCompletionValidation(task, settings)
    if (!task.comments) task.comments = []

    if (validation.ok) {
      markValidatedTaskCompleted(task, { now })
      task.retryScheduledAt = null
      task.deadLetteredAt = null
      task.checkpoint = {
        ...(task.checkpoint || {}),
        lastRunId: sessionId,
        lastSessionId: sessionId,
        note: 'Recovered completed task state from finished session.',
        updatedAt: now,
      }
      task.comments.push({
        id: genId(),
        author: 'System',
        text: 'Recovered completed task state from a finished execution session.',
        createdAt: now,
      })
      reconciled++
      terminalTasks.push(task)
    } else {
      const failureReason = formatValidationFailure(validation.reasons).slice(0, 500)
      const retryState = scheduleRetryOrDeadLetter(task, failureReason)
      task.completedAt = retryState === 'dead_lettered' ? null : task.completedAt
      task.comments.push({
        id: genId(),
        author: 'System',
        text: `Recovered finished session but the task result failed validation.\n\n${validation.reasons.map((reason) => `- ${reason}`).join('\n')}`,
        createdAt: now,
      })
      if (retryState === 'retry') {
        pushQueueUnique(queue, task.id)
        queueDirty = true
        reconciled++
        pushMainLoopEventToMainSessions({
          type: 'task_retry_scheduled',
          text: `Task retry scheduled: "${task.title}" (${task.id}) attempt ${task.attempts}/${task.maxAttempts} in ${task.retryBackoffSec}s.`,
        })
      } else {
        deadLettered++
        terminalTasks.push(task)
      }
    }

    if (session.heartbeatEnabled !== false) {
      session.heartbeatEnabled = false
      session.lastActiveAt = now
      sessionsDirty = true
    }
    tasksDirty = true
  }

  if (tasksDirty) {
    saveTasks(tasks)
    notify('tasks')
    notify('runs')
  }
  if (sessionsDirty) saveSessions(sessions as Record<string, Session>)
  if (queueDirty) saveQueue(queue)

  for (const task of terminalTasks) {
    if (task.status === 'completed') {
      logActivity({ entityType: 'task', entityId: task.id, action: 'completed', actor: 'system', actorId: task.agentId, summary: `Task completed: "${task.title}"` })
      pushMainLoopEventToMainSessions({
        type: 'task_completed',
        text: `Task completed: "${task.title}" (${task.id})`,
      })
      notifyOrchestrators(`Task completed: "${task.title}"`, `task-complete:${task.id}`)
    } else if (task.status === 'failed') {
      logActivity({ entityType: 'task', entityId: task.id, action: 'failed', actor: 'system', actorId: task.agentId, summary: `Task failed: "${task.title}"` })
      pushMainLoopEventToMainSessions({
        type: 'task_failed',
        text: `Task failed validation: "${task.title}" (${task.id})`,
      })
      notifyOrchestrators(`Task failed: "${task.title}" — validation failure`, `task-fail:${task.id}`)
    }
    handleTerminalTaskResultDeliveries(task)
    cleanupTerminalOneOffSchedule(task)
  }

  return { reconciled, deadLettered }
}

function cleanupTerminalOneOffSchedule(task: BoardTask): void {
  void task
}

function pushUserFacingTaskResult(task: BoardTask, sessions: Record<string, SessionLike>): void {
  if (task.status !== 'completed' && task.status !== 'failed') return
  const targetSessionId = resolveTaskTerminalChatSessionId(task, sessions)
  if (!targetSessionId) return
  const targetSession = sessions[targetSessionId]
  if (!targetSession) return

  const delivery = collectTaskResultDeliveryData(task, sessions)
  const taskLink = `[${task.title}](#task:${task.id})`
  const body = buildTaskTerminalMessage(`Task ${delivery.statusLabel}: **${taskLink}**`, task, delivery)
  const now = Date.now()
  const lastMsg = getLastMessage(targetSessionId)
  if (lastMsg?.role === 'assistant' && lastMsg?.text === body && typeof lastMsg?.time === 'number' && now - lastMsg.time < 30_000) {
    return
  }

  const message: Message = {
    role: 'assistant',
    text: body,
    time: now,
    kind: 'system',
  }
  if (delivery.firstImage) message.imageUrl = delivery.firstImage.url
  appendMessage(targetSessionId, message)
  notify(`messages:${targetSessionId}`)
}

function deliverTaskConnectorFollowups(task: BoardTask, sessions: Record<string, SessionLike>): void {
  if (task.status !== 'completed' && task.status !== 'failed') return
  const delivery = collectTaskResultDeliveryData(task, sessions)
  void notifyConnectorTaskFollowups({
    task,
    statusLabel: delivery.statusLabel,
    summaryText: delivery.resultBody || '',
    imageUrl: delivery.firstImage?.url,
    mediaPath: delivery.followupMediaPath,
    mediaFileName: delivery.mediaFileName,
  })
}

function handleTerminalTaskResultDeliveries(task: BoardTask): void {
  const sessions = loadSessions() as Record<string, SessionLike>
  pushUserFacingTaskResult(task, sessions)
  deliverTaskConnectorFollowups(task, sessions)
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
  log.info(TAG, `[queue] Disabled heartbeat on session ${sessionId} (task finished)`)
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

  logActivity({ entityType: 'task', entityId: taskId, action: 'queued', actor: 'system', summary: `Task queued: "${task.title}"` })

  pushMainLoopEventToMainSessions({
    type: 'task_queued',
    text: `Task queued: "${task.title}" (${task.id})`,
  })

  // If processNext is at capacity, mark a pending kick so it picks up work when a slot frees
  if (_queueState.activeCount >= _queueState.maxConcurrent) {
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

    const previousValidation = task.validation || null
    const previousReportPath = task.completionReportPath || null
    const { validation } = refreshTaskCompletionValidation(task, settings)
    if (task.completionReportPath !== previousReportPath) {
      tasksDirty = true
    }
    const validationChanged = didTaskValidationChange(previousValidation, validation)

    if (validationChanged) {
      tasksDirty = true
    }

    if (validation.ok) {
      if (!task.completedAt) {
        markValidatedTaskCompleted(task, { now, preserveCompletedAt: true })
        tasksDirty = true
      }
      continue
    }

    markInvalidCompletedTaskFailed(task, validation, {
      now,
      comment: {
        author: 'System',
        text: `Task auto-failed completed-queue validation.\n\n${validation.reasons.map((r) => `- ${r}`).join('\n')}`,
      },
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
    log.warn(TAG, `[queue] Demoted ${demoted} invalid completed task(s) to failed after validation audit`)
  }
  return { checked, demoted }
}

function scheduleRetryOrDeadLetter(task: BoardTask, reason: string): 'retry' | 'dead_lettered' {
  if (isCancelledTask(task)) {
    task.retryScheduledAt = null
    task.deadLetteredAt = null
    task.updatedAt = Date.now()
    return 'dead_lettered'
  }
  applyTaskPolicyDefaults(task)
  const now = Date.now()
  task.attempts = (task.attempts || 0) + 1

  if ((task.attempts || 0) < (task.maxAttempts || 1)) {
    const delayMs = jitteredBackoff((task.retryBackoffSec || 30) * 1000, Math.max(0, (task.attempts || 1) - 1), 6 * 3600_000)
    task.status = 'queued'
    task.retryScheduledAt = now + delayMs
    task.updatedAt = now
    task.error = `Retry scheduled after failure: ${reason}`.slice(0, 500)
    if (!task.comments) task.comments = []
    task.comments.push({
      id: genId(),
      author: 'System',
      text: `Attempt ${task.attempts}/${task.maxAttempts} failed. Retrying in ${Math.round(delayMs / 1000)}s.\n\nReason: ${reason}`,
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
  notifyOrchestrators(`Task failed: "${task.title}" — ${(reason || 'unknown error').slice(0, 100)}`, `task-fail:${task.id}`)
  if (task.sessionId) {
    const failure = classifyRuntimeFailure({ source: 'task', message: reason })
    recordSupervisorIncident({
      runId: task.id,
      sessionId: task.sessionId,
      taskId: task.id,
      agentId: task.agentId || null,
      source: 'task',
      kind: 'runtime_failure',
      severity: failure.severity,
      summary: `Task dead-lettered: ${reason}`.slice(0, 320),
      details: reason,
      failureFamily: failure.family,
      remediation: failure.remediation,
      repairPrompt: failure.repairPrompt,
      autoAction: null,
    })
  }

  // Guardian recovery is approval-backed. Dead-lettering prepares a restore
  // request instead of mutating the workspace automatically.
  const agents = loadAgents()
  const agent = task.agentId ? agents[task.agentId] : null
  if (agent?.autoRecovery) {
    const cwd = task.projectId 
      ? path.join(WORKSPACE_DIR, 'projects', task.projectId) 
      : WORKSPACE_DIR
    const recovery = prepareGuardianRecovery({
      cwd,
      reason,
      requester: `task:${task.id}`,
    })
    if (recovery.ok && recovery.approval) {
      task.comments.push({
        id: genId(),
        author: 'Guardian',
        text: `Recovery prepared for checkpoint ${recovery.checkpoint?.head.slice(0, 12) || 'unknown'}.\n\nApprove restore request ${recovery.approval.id} to roll the workspace back safely.`,
        createdAt: now + 1,
      })
    } else {
      task.comments.push({
        id: genId(),
        author: 'Guardian',
        text: `Recovery advisory: ${recovery.reason || 'Unable to prepare a restore request.'}`,
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
    if (blockers.some((blockerId) => tasks[blockerId]?.status !== 'completed')) return false
    // Skip pool-mode tasks that haven't been claimed yet
    if (task.assignmentMode === 'pool' && !task.claimedByAgentId) return false
    return true
  })
  if (idx === -1) return null
  const [taskId] = queue.splice(idx, 1)
  return taskId || null
}

export async function processNext() {
  const settings = loadSettings()
  _queueState.maxConcurrent = normalizeInt(
    (settings as Record<string, unknown>).taskQueueConcurrency, 3, 1, 10
  )

  if (_queueState.activeCount >= _queueState.maxConcurrent) {
    _queueState.pendingKick = true
    return
  }
  _queueState.activeCount++
  const endQueuePerf = perf.start('queue', 'processNext')

  try {
    // Recover orphaned tasks: status is 'queued' but missing from the queue array
    // Only run from the first worker to avoid redundant scans
    if (_queueState.activeCount === 1) {
      const allTasks = loadTasks()
      const currentQueue = loadQueue()
      const queueSet = new Set(currentQueue)
      let recovered = false
      for (const [id, t] of Object.entries(allTasks) as [string, BoardTask][]) {
        if (t.status === 'queued' && !queueSet.has(id)) {
          log.info(TAG, `[queue] Recovering orphaned queued task: "${t.title}" (${id})`)
          pushQueueUnique(currentQueue, id)
          recovered = true
        }
      }
      if (recovered) saveQueue(currentQueue)
    }

    // Process ONE task per invocation (no while loop)
    {
      const tasks = loadTasks()
      const queue = loadQueue()
      if (queue.length === 0) return

      const taskId = dequeueNextRunnableTask(queue, tasks as Record<string, BoardTask>)
      saveQueue(queue)
      if (!taskId) return
      const latestTasks = loadTasks() as Record<string, BoardTask>
      let task = latestTasks[taskId] as BoardTask | undefined

      if (!task || task.status !== 'queued') {
        return
      }

      // Dependency guard: skip tasks whose blockers are not all completed
      const blockers = Array.isArray(task.blockedBy) ? task.blockedBy as string[] : []
      if (blockers.length > 0) {
        const allBlockersDone = blockers.every((bid) => {
          const blocker = latestTasks[bid] as BoardTask | undefined
          return blocker?.status === 'completed'
        })
        if (!allBlockersDone) {
          // Put it back in the queue and skip
          pushQueueUnique(queue, taskId)
          saveQueue(queue)
          log.info(TAG, `[queue] Skipping task "${task.title}" (${taskId}) — blocked by incomplete dependencies`)
          return
        }
      }

      const agents = loadAgents()
      let agent = agents[task.agentId]
      if (!agent) {
        task.status = 'failed'
        task.deadLetteredAt = Date.now()
        task.error = `Agent ${task.agentId} not found`
        task.updatedAt = Date.now()
        saveTasks(latestTasks)
        pushMainLoopEventToMainSessions({
          type: 'task_failed',
          text: `Task failed: "${task.title}" (${task.id}) — agent not found.`,
        })
        return
      }

      // Capability matching — reroute if assigned agent doesn't have required capabilities
      const reqCaps = Array.isArray(task.requiredCapabilities) ? task.requiredCapabilities as string[] : []
      if (reqCaps.length > 0 && !matchesCapabilities(agent.capabilities, reqCaps)) {
        const candidates = filterAgentsByCapabilities(agents, reqCaps)
          .filter((a) => a.id !== agent!.id && !a.disabled)
        if (candidates.length > 0) {
          // Pick best match by capability score, then alphabetically for stability
          candidates.sort((a, b) => {
            const scoreA = capabilityMatchScore(a.capabilities, reqCaps)
            const scoreB = capabilityMatchScore(b.capabilities, reqCaps)
            if (scoreB !== scoreA) return scoreB - scoreA
            return a.name.localeCompare(b.name)
          })
          const rerouted = candidates[0]
          log.info(TAG, `[queue] Rerouting task "${task.title}" (${taskId}) from agent "${agent.name}" to "${rerouted.name}" — capability match`)
          task.agentId = rerouted.id
          agent = rerouted
        } else {
          task.status = 'failed'
          task.deadLetteredAt = Date.now()
          task.error = `No agent matches required capabilities: [${reqCaps.join(', ')}]`
          task.updatedAt = Date.now()
          saveTasks(latestTasks)
          pushMainLoopEventToMainSessions({
            type: 'task_failed',
            text: `Task failed: "${task.title}" (${task.id}) — no agent matches required capabilities [${reqCaps.join(', ')}].`,
          })
          return
        }
      }

      if (isAgentDisabled(agent)) {
        const now = Date.now()
        task.deferredReason = buildAgentDisabledMessage(agent, 'process queued tasks')
        task.status = 'deferred'
        task.updatedAt = now
        task.retryScheduledAt = null
        saveTasks(latestTasks)
        notify('tasks')
        pushMainLoopEventToMainSessions({
          type: 'task_deferred',
          text: `Task deferred: "${task.title}" (${task.id}) — agent ${task.agentId} is disabled.`,
        })
        return
      }

      // Budget enforcement gate
      const typedAgent = agent as Agent
      if (typedAgent.monthlyBudget || typedAgent.dailyBudget || typedAgent.hourlyBudget) {
        try {
          const budgetCheck = checkAgentBudgetLimits(typedAgent)
          if (!budgetCheck.ok) {
            const now = Date.now()
            const exceeded = budgetCheck.exceeded[0]
            task.status = 'deferred'
            task.deferredReason = exceeded?.message || 'Agent budget exceeded'
            task.retryScheduledAt = null
            task.updatedAt = now
            saveTasks(latestTasks)
            notify('tasks')

            recordSupervisorIncident({
              runId: task.id,
              sessionId: task.sessionId || '',
              taskId: task.id,
              agentId: typedAgent.id,
              source: 'task',
              kind: 'budget_pressure',
              severity: 'high',
              summary: exceeded?.message || `Agent "${typedAgent.name}" budget exceeded, task deferred.`,
              autoAction: 'budget_trim',
            })
            return
          }
        } catch {}
      }

      const beforeStartTasks = loadTasks() as Record<string, BoardTask>
      task = beforeStartTasks[taskId] as BoardTask | undefined
      if (!task || task.status !== 'queued') {
        return
      }

      // Mark as running
      applyTaskPolicyDefaults(task)
      task.status = 'running'
      task.startedAt = Date.now()
      task.lastActivityAt = Date.now()
      task.retryScheduledAt = null
      task.deadLetteredAt = null
      // Clear transient failure fields so validation/error state reflects only this attempt.
      task.error = null
      task.validation = null
      task.updatedAt = Date.now()
      logActivity({ entityType: 'task', entityId: taskId, action: 'running', actor: 'system', actorId: task.agentId, summary: `Task started: "${task.title}"` })

      const sessionsForCwd = loadSessions() as Record<string, SessionLike>
      const taskCwd = resolveTaskExecutionCwd(task as ScheduleTaskMeta, sessionsForCwd)
      task.cwd = taskCwd
      let sessionId = ''
      const scheduleTask = task as ScheduleTaskMeta
      const isScheduleTask = scheduleTask.sourceType === 'schedule'
      const sourceScheduleId = typeof scheduleTask.sourceScheduleId === 'string'
        ? scheduleTask.sourceScheduleId
        : ''
      const reusableTaskSessionId = resolveReusableTaskSessionId(task, beforeStartTasks, sessionsForCwd)
      const resumeContext = resolveTaskResumeContext(task, beforeStartTasks, sessionsForCwd as Record<string, SessionLike | Session>)

      // Resolve the agent's persistent thread session to use as parentSessionId
      const agentThreadSessionId = agent.threadSessionId || null
      const taskRoutePreferences = deriveTaskRoutePreferences(task)

      if (isScheduleTask && sourceScheduleId) {
        const schedules = loadSchedules()
        const linkedSchedule = schedules[sourceScheduleId]
        const linkedScheduleRecord = linkedSchedule as unknown as Record<string, unknown> | undefined
        const existingSessionId = typeof linkedScheduleRecord?.lastSessionId === 'string'
          ? linkedScheduleRecord.lastSessionId
          : ''
        if (existingSessionId) {
          const sessions = loadSessions()
          if (sessions[existingSessionId]) {
            sessionId = existingSessionId
          }
        }
        if (!sessionId) {
          sessionId = createAgentTaskSession(
            agent,
            task.title,
            agentThreadSessionId || undefined,
            taskCwd,
            taskRoutePreferences,
          )
        }
        if (linkedScheduleRecord && linkedScheduleRecord.lastSessionId !== sessionId) {
          linkedScheduleRecord.lastSessionId = sessionId
          linkedScheduleRecord.updatedAt = Date.now()
          const updatedLinkedSchedule = linkedScheduleRecord as unknown as typeof linkedSchedule
          schedules[sourceScheduleId] = updatedLinkedSchedule
          saveSchedules(schedules)
        }
      } else {
        sessionId = reusableTaskSessionId || createAgentTaskSession(
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
      saveTasks(beforeStartTasks)
      noteMissionTaskStarted(task, task.id)
      pushMainLoopEventToMainSessions({
        type: 'task_running',
        text: `Task running: "${task.title}" (${task.id}) with ${agent.name}`,
      })

      // Save initial assistant message so user sees context when opening the session
      {
        const sessionExists = Boolean(loadSessions()[sessionId])
        if (sessionExists) {
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
          // Inject upstream task results context
          if (Array.isArray(task.upstreamResults) && task.upstreamResults.length > 0) {
            const upstreamBlock = task.upstreamResults
              .map((ur) => `### ${ur.taskTitle}\n${ur.resultPreview || '(no result)'}`)
              .join('\n\n')
            initialText += `\n\n## Context from upstream tasks\n\n${upstreamBlock}`
          }
          appendMessage(sessionId, {
            role: 'assistant',
            text: initialText,
            time: Date.now(),
            ...(isDelegation ? { kind: 'system' as const } : {}),
          })
        }
      }

      log.info(TAG, `[queue] Running task "${task.title}" (${taskId}) with ${agent.name}`)

      try {
        const taskRunId = `${taskId}:attempt-${(task.attempts || 0) + 1}`
        const endTaskRunPerf = perf.start('queue', 'executeTaskRun', { taskId, agentName: agent.name })
        const taskRunHandle = enqueueExecution({
          kind: 'task_attempt',
          task,
          agent,
          sessionId,
          executionId: taskRunId,
        })
        const taskRun = await taskRunHandle.promise
        endTaskRunPerf()
        // Update lastActivityAt after execution completes (idle timeout tracking)
        {
          const latestTasks = loadTasks() as Record<string, BoardTask>
          const updatedTask = latestTasks[taskId]
          if (updatedTask) {
            updatedTask.lastActivityAt = Date.now()
            saveTasks(latestTasks)
          }
        }
        const result = taskRun.error
          ? (taskRun.text || `Error: ${taskRun.error}`)
          : taskRun.text
        const t2 = loadTasks()
        const settings = loadSettings()
        if (isCancelledTask(t2[taskId])) {
          disableSessionHeartbeat(t2[taskId].sessionId)
          notify('tasks')
          notify('runs')
          queueTaskAutonomyObservation({
            runId: taskRunId,
            sessionId,
            taskId,
            agentId: agent.id,
            status: 'cancelled',
            error: t2[taskId].error || 'Task cancelled',
            toolEvents: taskRun.toolEvents,
            sourceMessage: task.description || task.title,
          })
          log.warn(TAG, `[queue] Task "${task.title}" cancelled during execution`)
          return
        }
        if (t2[taskId]) {
          applyTaskPolicyDefaults(t2[taskId])
          // Structured extraction: Zod-validated result with typed artifacts
          const taskResult = extractTaskResult(
            getMessages(sessionId),
            result || null,
            { sinceTime: typeof t2[taskId].startedAt === 'number' ? t2[taskId].startedAt : null },
          )
          const enrichedResult = formatResultBody(taskResult)
          t2[taskId].result = enrichedResult.slice(0, 4000) || null
          t2[taskId].artifacts = taskResult.artifacts.slice(0, 24)
          t2[taskId].outputFiles = extractLikelyOutputFiles(enrichedResult).slice(0, 24)
          t2[taskId].updatedAt = Date.now()
          const { validation } = refreshTaskCompletionValidation(t2[taskId], settings)

          const now = Date.now()
          // Add a completion/failure comment from the executing agent.
          if (!t2[taskId].comments) t2[taskId].comments = []

          if (validation.ok) {
            markValidatedTaskCompleted(t2[taskId], { now })
            t2[taskId].retryScheduledAt = null
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
            const execSession = execSessions[sessionId] as unknown as Record<string, unknown> | undefined
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
              log.info(TAG, `[queue] CLI resume IDs for task ${taskId}: claude=${claudeId}, codex=${codexId}, opencode=${opencodeId}, gemini=${geminiId}`)
            }
          } catch (e) {
            log.warn(TAG, `[queue] Failed to extract CLI resume IDs for task ${taskId}:`, e)
          }

          saveTasks(t2)
          notify('tasks')
          notify('runs')
          disableSessionHeartbeat(t2[taskId].sessionId)
        }
        const doneTask = t2[taskId]
        if (doneTask?.status === 'completed') {
          noteMissionTaskFinished(doneTask, 'completed', taskRunId)
        } else if (doneTask?.status === 'failed') {
          noteMissionTaskFinished(doneTask, 'failed', taskRunId)
        } else if (doneTask?.status === 'cancelled') {
          noteMissionTaskFinished(doneTask, 'cancelled', taskRunId)
        }
        queueTaskAutonomyObservation({
          runId: taskRunId,
          sessionId,
          taskId,
          agentId: agent.id,
          status: doneTask?.status === 'completed'
            ? 'completed'
            : doneTask?.status === 'cancelled'
              ? 'cancelled'
              : 'failed',
          resultText: doneTask?.result || result || null,
          error: doneTask?.status === 'completed' ? null : (doneTask?.error || taskRun.error || null),
          toolEvents: taskRun.toolEvents,
          sourceMessage: task.description || task.title,
        })
        if (doneTask?.status === 'completed') {
          pushMainLoopEventToMainSessions({
            type: 'task_completed',
            text: `Task completed: "${task.title}" (${taskId})`,
          })
          notifyOrchestrators(`Task completed: "${task.title}"`, `task-complete:${taskId}`)
          handleTerminalTaskResultDeliveries(doneTask)
          cleanupTerminalOneOffSchedule(doneTask)
          // Clean up LangGraph checkpoints for completed tasks
          getCheckpointSaver().deleteThread(taskId).catch((e) =>
            log.warn(TAG, `[queue] Failed to clean up checkpoints for task ${taskId}:`, e)
          )
          // Cascade unblock: auto-queue tasks whose blockers are all done
          const latestTasks = loadTasks()
          const unblockedIds = cascadeUnblock(latestTasks, taskId)
          if (unblockedIds.length > 0) {
            saveTasks(latestTasks)
            for (const uid of unblockedIds) {
              enqueueTask(uid)
              log.info(TAG, `[queue] Auto-unblocked task "${latestTasks[uid]?.title}" (${uid})`)
            }
            notify('tasks')
          }
          // Wake waiting protocol runs when a linked task completes
          if (latestTasks[taskId]?.protocolRunId) {
            try {
              const { wakeProtocolRunFromTaskCompletion } = await import('@/lib/server/protocols/protocol-service')
              wakeProtocolRunFromTaskCompletion(taskId)
            } catch (e) {
              log.warn(TAG, `[queue] Failed to wake protocol run for task ${taskId}:`, e)
            }
          }
          log.info(TAG, `[queue] Task "${task.title}" completed`)
        } else if (doneTask?.status === 'cancelled') {
          log.warn(TAG, `[queue] Task "${task.title}" cancelled during execution`)
        } else {
          if (doneTask?.status === 'queued') {
            log.warn(TAG, `[queue] Task "${task.title}" scheduled for retry`)
          } else {
            pushMainLoopEventToMainSessions({
              type: 'task_failed',
              text: `Task failed validation: "${task.title}" (${taskId})`,
            })
            notifyOrchestrators(`Task failed: "${task.title}" — validation failure`, `task-fail:${taskId}`)
            if (doneTask?.status === 'failed') {
              handleTerminalTaskResultDeliveries(doneTask)
              cleanupTerminalOneOffSchedule(doneTask)
            }
            log.warn(TAG, `[queue] Task "${task.title}" failed completion validation`)
          }
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err || 'Unknown error')
        log.error(TAG, `[queue] Task "${task.title}" failed:`, errMsg)
        const taskRunId = `${taskId}:attempt-${(task.attempts || 0) + 1}`
        const t2 = loadTasks()
        if (isCancelledTask(t2[taskId])) {
          disableSessionHeartbeat(t2[taskId].sessionId)
          notify('tasks')
          notify('runs')
          queueTaskAutonomyObservation({
            runId: taskRunId,
            sessionId,
            taskId,
            agentId: agent.id,
            status: 'cancelled',
            error: t2[taskId].error || errMsg,
            sourceMessage: task.description || task.title,
          })
          log.warn(TAG, `[queue] Task "${task.title}" aborted because it was cancelled`)
          return
        }
        if (t2[taskId]) {
          applyTaskPolicyDefaults(t2[taskId])

          // Auto-repair: attempt a repair turn before retrying if a repairPrompt is available
          const failureClassification = classifyRuntimeFailure({ source: 'task', message: errMsg })
          if (failureClassification.repairPrompt && t2[taskId].sessionId) {
            try {
              const repairRunId = `repair:${taskId}:${Date.now()}`
              t2[taskId].repairRunId = repairRunId
              t2[taskId].lastRepairAttemptAt = Date.now()
              saveTasks(t2)
              await enqueueExecution({
                kind: 'session_turn',
                input: {
                  sessionId: t2[taskId].sessionId!,
                  message: `[AUTO-REPAIR] ${failureClassification.repairPrompt}\n\nOriginal error: ${errMsg.slice(0, 300)}`,
                  internal: true,
                  source: 'task-repair',
                  mode: 'followup',
                  dedupeKey: repairRunId,
                },
              }).promise
              log.info(TAG, `[queue] Repair turn completed for task "${task.title}" (${taskId})`)
            } catch (repairErr: unknown) {
              log.warn(TAG, `[queue] Repair turn failed for task "${task.title}":`, repairErr instanceof Error ? repairErr.message : String(repairErr))
              // If repair fails, attempt guardian recovery
              const taskCwd = t2[taskId].cwd || WORKSPACE_DIR
              prepareGuardianRecovery({
                cwd: taskCwd,
                reason: `Auto-repair failed for task "${task.title}": ${errMsg.slice(0, 200)}`,
                requester: agent.id,
              })
            }
          }

          // Reload tasks after the async repair turn to avoid overwriting concurrent mutations
          const t3 = loadTasks()
          // Carry forward repair fields that were saved before the async turn
          if (t2[taskId].repairRunId && t3[taskId]) {
            t3[taskId].repairRunId = t2[taskId].repairRunId
            t3[taskId].lastRepairAttemptAt = t2[taskId].lastRepairAttemptAt
          }
          const retryState = scheduleRetryOrDeadLetter(t3[taskId], errMsg.slice(0, 500) || 'Unknown error')
          if (!t3[taskId].comments) t3[taskId].comments = []
          // Only add a failure comment if the last comment isn't already an error comment
          const lastComment = t3[taskId].comments!.at(-1)
          const isRepeatError = lastComment?.agentId === agent.id && lastComment?.text.startsWith('Task failed')
          if (!isRepeatError) {
            t3[taskId].comments!.push({
              id: genId(),
              author: agent.name,
              agentId: agent.id,
              text: 'Task failed — see error details above.',
              createdAt: Date.now(),
            })
          }
          saveTasks(t3)
          if (t3[taskId].status === 'failed') {
            noteMissionTaskFinished(t3[taskId], 'failed', taskRunId)
          } else if (t3[taskId].status === 'cancelled') {
            noteMissionTaskFinished(t3[taskId], 'cancelled', taskRunId)
          }
          notify('tasks')
          notify('runs')
          disableSessionHeartbeat(t3[taskId].sessionId)
          if (retryState === 'retry') {
            const qRetry = loadQueue()
            pushQueueUnique(qRetry, taskId)
            saveQueue(qRetry)
            pushMainLoopEventToMainSessions({
              type: 'task_retry_scheduled',
              text: `Task retry scheduled: "${task.title}" (${taskId}) attempt ${t3[taskId].attempts}/${t3[taskId].maxAttempts}.`,
            })
          }
        }
        queueTaskAutonomyObservation({
          runId: taskRunId,
          sessionId,
          taskId,
          agentId: agent.id,
          status: 'failed',
          error: errMsg,
          sourceMessage: task.description || task.title,
        })
        const latest = loadTasks()[taskId] as BoardTask | undefined
        if (latest?.status === 'queued') {
          log.warn(TAG, `[queue] Task "${task.title}" queued for retry after error`)
        } else if (latest?.status === 'cancelled') {
          log.warn(TAG, `[queue] Task "${task.title}" stayed cancelled after abort`)
        } else {
          pushMainLoopEventToMainSessions({
            type: 'task_failed',
            text: `Task failed: "${task.title}" (${taskId}) — ${errMsg.slice(0, 200)}`,
          })
          if (latest?.status === 'failed') {
            handleTerminalTaskResultDeliveries(latest)
            cleanupTerminalOneOffSchedule(latest)
          }
        }
      }
    }
  } finally {
    _queueState.activeCount--
    endQueuePerf()
    const pendingKick = _queueState.pendingKick
    _queueState.pendingKick = false
    if (pendingKick) {
      setTimeout(() => processNext(), 0)
      return
    }

    // Only re-kick when work is actually runnable. This avoids hot loops when the
    // queue only contains blocked, deferred, or retry-gated tasks.
    const remainingQueue = loadQueue()
    if (!remainingQueue.length) return
    const tasks = loadTasks() as Record<string, BoardTask>
    const probeQueue = [...remainingQueue]
    const nextRunnableTaskId = dequeueNextRunnableTask(probeQueue, tasks)
    if (nextRunnableTaskId) {
      setTimeout(() => processNext(), 0)
    }
  }
}

/** On boot, disable heartbeat on sessions whose tasks are already terminal. */
export function cleanupFinishedTaskSessions() {
  const tasks = loadTasks()
  const sessions = loadSessions()
  let cleaned = 0
  for (const task of Object.values(tasks) as BoardTask[]) {
    if ((task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') && task.sessionId) {
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
    log.info(TAG, `[queue] Disabled heartbeat on ${cleaned} session(s) with finished tasks`)
  }
}

/** Recover running tasks that appear stalled and requeue/dead-letter them per retry policy. */
export function recoverStalledRunningTasks(): { recovered: number; deadLettered: number } {
  const finished = reconcileFinishedRunningTasks()
  const settings = loadSettings()
  const stallTimeoutMin = normalizeInt(settings.taskStallTimeoutMin, 45, 5, 24 * 60)
  const staleMs = stallTimeoutMin * 60_000
  const idleTimeoutMin = normalizeInt((settings as Record<string, unknown>).taskIdleTimeoutMin, 15, 2, 120)
  const idleMs = idleTimeoutMin * 60_000
  const now = Date.now()
  const tasks = loadTasks()
  const queue = loadQueue()
  let recovered = finished.reconciled
  let deadLettered = finished.deadLettered
  let changed = false

  for (const task of Object.values(tasks) as BoardTask[]) {
    if (task.status !== 'running') continue
    if (!task.startedAt) {
      const recoveredAt = Date.now()
      task.status = 'queued'
      task.queuedAt = task.queuedAt || recoveredAt
      task.retryScheduledAt = Date.now() + 30_000
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
    // Existing stall check (overall timeout based on updatedAt/startedAt)
    const since = Math.max(task.updatedAt || 0, task.startedAt || 0)
    const isStalled = since > 0 && (now - since) >= staleMs

    // Idle check (no LLM output for idleTimeoutMin)
    const lastActivity = task.lastActivityAt || task.startedAt || 0
    const idleDuration = lastActivity > 0 ? now - lastActivity : 0
    const isIdle = lastActivity > 0 && idleDuration >= idleMs

    if (!isStalled && !isIdle) continue

    const reason = isIdle
      ? `Idle timeout: no output for ${Math.round(idleDuration / 60_000)}m`
      : `Detected stalled run after ${stallTimeoutMin}m without progress`
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
      notifyOrchestrators(`Task failed: "${task.title}" — stalled and dead-lettered`, `task-fail:${task.id}`)
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

let _resumeQueueCalled = false

export function claimPoolTask(taskId: string, agentId: string): { success: boolean; error?: string } {
  // Atomic claim inside a SQLite transaction to prevent concurrent double-claims
  const result = withTransaction(() => {
    const tasks = loadTasks() as Record<string, BoardTask>
    const task = tasks[taskId]
    if (!task) return { success: false as const, error: 'Task not found' }
    if (task.assignmentMode !== 'pool') return { success: false as const, error: 'Task is not in pool mode' }
    if (task.claimedByAgentId) return { success: false as const, error: `Task already claimed by ${task.claimedByAgentId}` }
    if (task.status !== 'queued' && task.status !== 'backlog') return { success: false as const, error: `Task status is ${task.status}, not claimable` }
    const candidates = Array.isArray(task.poolCandidateAgentIds) ? task.poolCandidateAgentIds : []
    if (candidates.length > 0 && !candidates.includes(agentId)) {
      return { success: false as const, error: 'Agent is not in the candidate pool for this task' }
    }
    // Capability check — reject claim if agent doesn't have required capabilities
    const taskReqCaps = Array.isArray(task.requiredCapabilities) ? task.requiredCapabilities as string[] : []
    if (taskReqCaps.length > 0) {
      const allAgents = loadAgents()
      const claimingAgent = allAgents[agentId]
      if (!claimingAgent || !matchesCapabilities(claimingAgent.capabilities, taskReqCaps)) {
        return { success: false as const, error: `Agent does not match required capabilities: [${taskReqCaps.join(', ')}]` }
      }
    }
    task.claimedByAgentId = agentId
    task.claimedAt = Date.now()
    task.agentId = agentId
    task.updatedAt = Date.now()
    saveTasks(tasks)
    return { success: true as const, title: task.title }
  })
  if (!result.success) return result
  logActivity({ entityType: 'task', entityId: taskId, action: 'claimed', actor: 'agent', actorId: agentId, summary: `Task "${result.title}" claimed by agent ${agentId}` })
  notify('tasks')
  return { success: true }
}

export function listClaimableTasks(agentId: string): BoardTask[] {
  const tasks = loadTasks() as Record<string, BoardTask>
  return Object.values(tasks).filter((task) => {
    if (task.assignmentMode !== 'pool') return false
    if (task.claimedByAgentId) return false
    if (task.status !== 'queued' && task.status !== 'backlog') return false
    const candidates = Array.isArray(task.poolCandidateAgentIds) ? task.poolCandidateAgentIds : []
    return candidates.length === 0 || candidates.includes(agentId)
  })
}

/** Resume any queued tasks on server boot */
export function resumeQueue() {
  if (_resumeQueueCalled) return
  _resumeQueueCalled = true
  // Check for tasks stuck in 'queued' status but not in the queue array
  const tasks = loadTasks()
  const queue = loadQueue()
  let modified = false
  for (const task of Object.values(tasks) as BoardTask[]) {
    if (task.status === 'queued' && !queue.includes(task.id)) {
      applyTaskPolicyDefaults(task)
      log.info(TAG, `[queue] Recovering stuck queued task: "${task.title}" (${task.id})`)
      queue.push(task.id)
      task.queuedAt = task.queuedAt || Date.now()
      modified = true
    }
  }

  // Orphan reap: all running tasks are orphans on fresh daemon startup
  let recovered = 0
  for (const task of Object.values(tasks) as BoardTask[]) {
    if (task.status !== 'running') continue
    const reason = 'process_lost: task was running when daemon restarted'
    applyTaskPolicyDefaults(task)
    const outcome = scheduleRetryOrDeadLetter(task, reason)
    if (outcome === 'retry') {
      pushQueueUnique(queue, task.id)
    }
    if (!task.comments) task.comments = []
    task.comments.push({
      id: genId(),
      author: 'System',
      text: `Orphan recovery: ${reason}`,
      createdAt: Date.now(),
    })
    modified = true
    recovered++
  }
  if (recovered > 0) {
    log.info(TAG, `[queue] Recovered ${recovered} orphaned running task(s) on boot`)
  }

  if (modified) {
    saveQueue(queue)
    saveTasks(tasks)
  }

  if (queue.length > 0) {
    log.info(TAG, `[queue] Resuming ${queue.length} queued task(s) on boot`)
    processNext()
  }
}

/** Re-queue deferred tasks whose agents are now available. */
export function promoteDeferred(agentId?: string): number {
  const tasks = loadTasks() as Record<string, BoardTask>
  const agents = loadAgents()
  const queue = loadQueue()
  let promoted = 0

  for (const task of Object.values(tasks)) {
    if (task.status !== 'deferred') continue
    if (agentId && task.agentId !== agentId) continue

    const agent = agents[task.agentId]
    if (!agent || isAgentDisabled(agent as Agent)) continue

    // Check budget if applicable
    const typedAgent = agent as Agent
    if (typedAgent.monthlyBudget || typedAgent.dailyBudget || typedAgent.hourlyBudget) {
      try {
        const check = checkAgentBudgetLimits(typedAgent)
        if (!check.ok) continue // still over budget
      } catch {}
    }

    task.status = 'queued'
    task.deferredReason = null
    task.updatedAt = Date.now()
    pushQueueUnique(queue, task.id)
    promoted++
  }

  if (promoted > 0) {
    saveTasks(tasks)
    saveQueue(queue)
    notify('tasks')
    setTimeout(() => processNext(), 0)
  }
  return promoted
}
