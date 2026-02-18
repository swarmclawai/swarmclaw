import crypto from 'crypto'
import { loadTasks, saveTasks, loadQueue, saveQueue, loadAgents, loadSessions, saveSessions } from './storage'
import { createOrchestratorSession, executeOrchestrator } from './orchestrator'
import type { BoardTask } from '@/types'

let processing = false

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
          t2[taskId].status = 'completed'
          t2[taskId].result = result?.slice(0, 2000) || null
          t2[taskId].completedAt = Date.now()
          t2[taskId].updatedAt = Date.now()
          // Add a completion comment from the orchestrator
          if (!t2[taskId].comments) t2[taskId].comments = []
          t2[taskId].comments!.push({
            id: crypto.randomBytes(4).toString('hex'),
            author: agent.name,
            agentId: agent.id,
            text: `Task completed.\n\n${result?.slice(0, 1000) || 'No summary provided.'}`,
            createdAt: Date.now(),
          })
          saveTasks(t2)
        }
        console.log(`[queue] Task "${task.title}" completed`)
      } catch (err: any) {
        console.error(`[queue] Task "${task.title}" failed:`, err.message)
        const t2 = loadTasks()
        if (t2[taskId]) {
          t2[taskId].status = 'failed'
          t2[taskId].error = err.message?.slice(0, 500) || 'Unknown error'
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
