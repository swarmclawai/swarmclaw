import crypto from 'crypto'
import { loadTasks, saveTasks, loadQueue, saveQueue, loadAgents, loadSessions, saveSessions } from './storage'
import { createOrchestratorSession, executeOrchestrator } from './orchestrator'
import { formatValidationFailure, validateTaskCompletion } from './task-validation'
import { ensureTaskCompletionReport } from './task-reports'
import type { BoardTask } from '@/types'

let processing = false

function sameReasons(a?: string[] | null, b?: string[] | null): boolean {
  const av = Array.isArray(a) ? a : []
  const bv = Array.isArray(b) ? b : []
  if (av.length !== bv.length) return false
  for (let i = 0; i < av.length; i++) {
    if (av[i] !== bv[i]) return false
  }
  return true
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

  task.status = 'queued'
  task.queuedAt = Date.now()
  task.updatedAt = Date.now()
  saveTasks(tasks)

  const queue = loadQueue()
  if (!queue.includes(taskId)) {
    queue.push(taskId)
    saveQueue(queue)
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
      id: crypto.randomBytes(4).toString('hex'),
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

  if (tasksDirty) saveTasks(tasks)
  if (sessionsDirty) saveSessions(sessions)
  if (demoted > 0) {
    console.warn(`[queue] Demoted ${demoted} invalid completed task(s) to failed after validation audit`)
  }
  return { checked, demoted }
}

export async function processNext() {
  if (processing) return
  processing = true

  try {
    while (true) {
      const queue = loadQueue()
      if (queue.length === 0) break

      const taskId = queue[0]
      const tasks = loadTasks()
      const task = tasks[taskId] as BoardTask | undefined

      if (!task || task.status !== 'queued') {
        // Remove stale entry
        queue.shift()
        saveQueue(queue)
        continue
      }

      const agents = loadAgents()
      const agent = agents[task.agentId]
      if (!agent) {
        task.status = 'failed'
        task.error = `Agent ${task.agentId} not found`
        task.updatedAt = Date.now()
        saveTasks(tasks)
        queue.shift()
        saveQueue(queue)
        continue
      }

      // Mark as running
      task.status = 'running'
      task.startedAt = Date.now()
      task.updatedAt = Date.now()

      const taskCwd = task.cwd || process.cwd()
      const sessionId = createOrchestratorSession(agent, task.title, undefined, taskCwd)
      task.sessionId = sessionId
      saveTasks(tasks)

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
        const result = await executeOrchestrator(agent, task.description || task.title, sessionId)
        const t2 = loadTasks()
        if (t2[taskId]) {
          t2[taskId].result = result?.slice(0, 2000) || null
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
            t2[taskId].error = null
            t2[taskId].comments!.push({
              id: crypto.randomBytes(4).toString('hex'),
              author: agent.name,
              agentId: agent.id,
              text: `Task completed.\n\n${result?.slice(0, 1000) || 'No summary provided.'}`,
              createdAt: now,
            })
          } else {
            t2[taskId].status = 'failed'
            t2[taskId].completedAt = null
            t2[taskId].error = formatValidationFailure(validation.reasons).slice(0, 500)
            t2[taskId].comments!.push({
              id: crypto.randomBytes(4).toString('hex'),
              author: agent.name,
              agentId: agent.id,
              text: `Task failed validation and was not marked completed.\n\n${validation.reasons.map((r) => `- ${r}`).join('\n')}`,
              createdAt: now,
            })
          }

          saveTasks(t2)
          disableSessionHeartbeat(t2[taskId].sessionId)
        }
        const doneTask = t2[taskId]
        if (doneTask?.status === 'completed') {
          console.log(`[queue] Task "${task.title}" completed`)
        } else {
          console.warn(`[queue] Task "${task.title}" failed completion validation`)
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err || 'Unknown error')
        console.error(`[queue] Task "${task.title}" failed:`, errMsg)
        const t2 = loadTasks()
        if (t2[taskId]) {
          t2[taskId].status = 'failed'
          t2[taskId].error = errMsg.slice(0, 500) || 'Unknown error'
          t2[taskId].updatedAt = Date.now()
          if (!t2[taskId].comments) t2[taskId].comments = []
          // Only add a failure comment if the last comment isn't already an error comment
          const lastComment = t2[taskId].comments!.at(-1)
          const isRepeatError = lastComment?.agentId === agent.id && lastComment?.text.startsWith('Task failed')
          if (!isRepeatError) {
            t2[taskId].comments!.push({
              id: crypto.randomBytes(4).toString('hex'),
              author: agent.name,
              agentId: agent.id,
              text: 'Task failed — see error details above.',
              createdAt: Date.now(),
            })
          }
          saveTasks(t2)
          disableSessionHeartbeat(t2[taskId].sessionId)
        }
      }

      // Remove from queue
      const q2 = loadQueue()
      const idx = q2.indexOf(taskId)
      if (idx !== -1) {
        q2.splice(idx, 1)
        saveQueue(q2)
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

/** Resume any queued tasks on server boot */
export function resumeQueue() {
  // Check for tasks stuck in 'queued' status but not in the queue array
  const tasks = loadTasks()
  const queue = loadQueue()
  let modified = false
  for (const task of Object.values(tasks) as BoardTask[]) {
    if (task.status === 'queued' && !queue.includes(task.id)) {
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
