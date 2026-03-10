import type { BoardTask, Session } from '@/types'
import type { SessionLike } from '@/lib/server/tasks/task-followups'

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

export function buildTaskContinuationNote(
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
