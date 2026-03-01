import { genId } from '@/lib/id'
import { loadTasks, saveTasks, loadQueue, saveQueue, loadAgents, loadSchedules, saveSchedules, loadSessions, saveSessions, loadSettings } from './storage'
import { notify } from './ws-hub'
import { WORKSPACE_DIR } from './data-dir'
import { createOrchestratorSession, executeOrchestrator } from './orchestrator'
import { formatValidationFailure, validateTaskCompletion } from './task-validation'
import { ensureTaskCompletionReport } from './task-reports'
import { pushMainLoopEventToMainSessions } from './main-agent-loop'
import { executeSessionChatTurn } from './chat-execution'
import { extractTaskResult, formatResultBody } from './task-result'
import { getCheckpointSaver } from './langgraph-checkpoint'
import { isProtectedMainSession } from './main-session'
import type { Agent, BoardTask, Message } from '@/types'

let processing = false

interface SessionMessageLike {
  role?: string
  text?: string
  time?: number
  kind?: 'chat' | 'heartbeat' | 'system'
  toolEvents?: Array<{ name?: string; output?: string }>
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

function queueContains(queue: string[], id: string): boolean {
  return queue.includes(id)
}

function pushQueueUnique(queue: string[], id: string): void {
  if (!queueContains(queue, id)) queue.push(id)
}

function isMainSession(session: SessionLike | null | undefined): boolean {
  return isProtectedMainSession(session)
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

// Task result extraction now uses Zod-validated structured data
// from ./task-result.ts (extractTaskResult, formatResultBody)

async function executeTaskRun(
  task: BoardTask,
  agent: Agent,
  sessionId: string,
): Promise<string> {
  const prompt = task.description || task.title
  if (agent?.isOrchestrator) {
    return executeOrchestrator(agent, prompt, sessionId, task.id)
  }

  const run = await executeSessionChatTurn({
    sessionId,
    message: prompt,
    internal: false,
    source: 'task',
  })
  const text = typeof run.text === 'string' ? run.text.trim() : ''
  if (text) return text
  if (run.error) return `Error: ${run.error}`
  return ''
}

function notifyMainChatScheduleResult(task: BoardTask): void {
  const scheduleTask = task as ScheduleTaskMeta
  const sourceType = typeof scheduleTask.sourceType === 'string' ? scheduleTask.sourceType : ''
  if (sourceType !== 'schedule') return
  if (task.status !== 'completed' && task.status !== 'failed') return

  const sessions = loadSessions()
  const ownerUser = resolveTaskOwnerUser(scheduleTask, sessions as Record<string, SessionLike>)
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

  const buildMsg = (): Message => {
    const msg: Message = { role: 'assistant', text: body, time: now, kind: 'system' }
    if (firstImage) msg.imageUrl = firstImage.url
    return msg
  }

  for (const session of Object.values(sessions) as SessionLike[]) {
    if (!isMainSession(session)) continue
    if (ownerUser && session?.user && session.user !== ownerUser) continue
    const last = Array.isArray(session.messages) ? session.messages.at(-1) : null
    if (last?.role === 'assistant' && last?.text === body && typeof last?.time === 'number' && now - last.time < 30_000) continue
    if (!Array.isArray(session.messages)) session.messages = []
    session.messages.push(buildMsg())
    session.lastActiveAt = now
    changed = true
  }

  // Also push to the agent's persistent thread session
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

  const statusLabel = task.status === 'completed' ? 'completed' : 'failed'
  const taskLink = `[${task.title}](#task:${task.id})`
  const firstImage = taskResult.artifacts.find((a) => a.type === 'image')
  const now = Date.now()
  let changed = false

  // Build CLI resume ID info lines
  const resumeLines: string[] = []
  if (task.claudeResumeId) resumeLines.push(`Claude session: \`${task.claudeResumeId}\``)
  if (task.codexResumeId) resumeLines.push(`Codex thread: \`${task.codexResumeId}\``)
  if (task.opencodeResumeId) resumeLines.push(`OpenCode session: \`${task.opencodeResumeId}\``)
  // Fallback to legacy field
  if (resumeLines.length === 0 && task.cliResumeId) {
    resumeLines.push(`${task.cliProvider || 'CLI'} session: \`${task.cliResumeId}\``)
  }

  // Get working directory from execution session
  const execCwd = runSession?.cwd || ''

  const buildMsg = (text: string): Message => {
    const msg: Message = { role: 'assistant', text, time: now, kind: 'system' }
    if (firstImage) msg.imageUrl = firstImage.url
    return msg
  }

  const buildResultBlock = (prefix: string): string => {
    const parts = [prefix]
    if (execCwd) parts.push(`Working directory: \`${execCwd}\``)
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

  // 2. If delegated, push to delegating agent's thread
  const delegatedBy = (task as unknown as Record<string, unknown>).delegatedByAgentId
  if (typeof delegatedBy === 'string' && delegatedBy !== task.agentId) {
    const delegator = agents[delegatedBy]
    if (delegator?.threadSessionId && sessions[delegator.threadSessionId]) {
      const thread = sessions[delegator.threadSessionId]
      if (!Array.isArray(thread.messages)) thread.messages = []
      const agentName = agent?.name || task.agentId
      const body = buildResultBlock(`Delegated task ${statusLabel}: **${taskLink}** (by ${agentName})`)
      thread.messages.push(buildMsg(body))
      thread.lastActiveAt = now
      changed = true
    }
  }

  if (changed) saveSessions(sessions)
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

    const validation = validateTaskCompletion(task, { report })
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
  return 'dead_lettered'
}

function dequeueNextRunnableTask(queue: string[], tasks: Record<string, BoardTask>): string | null {
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
    return !retryAt || retryAt <= now
  })
  if (idx === -1) return null
  const [taskId] = queue.splice(idx, 1)
  return taskId || null
}

export async function processNext() {
  if (processing) return
  processing = true

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

      const taskCwd = task.cwd || WORKSPACE_DIR
      let sessionId = ''
      const scheduleTask = task as ScheduleTaskMeta
      const isScheduleTask = scheduleTask.sourceType === 'schedule'
      const sourceScheduleId = typeof scheduleTask.sourceScheduleId === 'string'
        ? scheduleTask.sourceScheduleId
        : ''

      // Resolve the agent's persistent thread session to use as parentSessionId
      const agentThreadSessionId = agent.threadSessionId || null

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
          sessionId = createOrchestratorSession(agent, task.title, agentThreadSessionId || undefined, taskCwd)
        }
        if (linkedSchedule && linkedSchedule.lastSessionId !== sessionId) {
          linkedSchedule.lastSessionId = sessionId
          linkedSchedule.updatedAt = Date.now()
          schedules[sourceScheduleId] = linkedSchedule
          saveSchedules(schedules)
        }
      } else {
        sessionId = createOrchestratorSession(agent, task.title, agentThreadSessionId || undefined, taskCwd)
      }

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
      task.checkpoint = {
        lastSessionId: sessionId,
        note: `Attempt ${(task.attempts || 0) + 1}/${task.maxAttempts || '?'} started`,
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
        sessions[sessionId].messages.push({
          role: 'assistant',
          text: `Starting task: **${task.title}**\n\n${task.description || ''}\n\nWorking directory: \`${taskCwd}\`\n\nI'll begin working on this now.`,
          time: Date.now(),
        })
        saveSessions(sessions)
      }

      console.log(`[queue] Running task "${task.title}" (${taskId}) with ${agent.name}`)

      try {
        const result = await executeTaskRun(task, agent, sessionId)
        const t2 = loadTasks()
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
          t2[taskId].updatedAt = Date.now()
          const report = ensureTaskCompletionReport(t2[taskId])
          if (report?.relativePath) t2[taskId].completionReportPath = report.relativePath
          const validation = validateTaskCompletion(t2[taskId], { report })
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
                | { claudeCode?: string | null; codex?: string | null; opencode?: string | null }
                | undefined
              // Store each CLI resume ID separately
              const claudeId = (execSession.claudeSessionId as string) || delegateIds?.claudeCode || null
              const codexId = (execSession.codexThreadId as string) || delegateIds?.codex || null
              const opencodeId = (execSession.opencodeSessionId as string) || delegateIds?.opencode || null
              if (claudeId) t2[taskId].claudeResumeId = claudeId
              if (codexId) t2[taskId].codexResumeId = codexId
              if (opencodeId) t2[taskId].opencodeResumeId = opencodeId
              // Keep backward-compat single field (first available)
              const primaryId = claudeId || codexId || opencodeId
              if (primaryId) {
                t2[taskId].cliResumeId = primaryId
                if (claudeId) t2[taskId].cliProvider = 'claude-cli'
                else if (codexId) t2[taskId].cliProvider = 'codex-cli'
                else if (opencodeId) t2[taskId].cliProvider = 'opencode-cli'
              }
              console.log(`[queue] CLI resume IDs for task ${taskId}: claude=${claudeId}, codex=${codexId}, opencode=${opencodeId}`)
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
    processing = false
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
