'use client'

import { useEffect, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { updateTask } from '@/lib/tasks'
import { TaskColumn } from './task-column'
import type { BoardTaskStatus } from '@/types'

const COLUMNS: BoardTaskStatus[] = ['backlog', 'queued', 'running', 'completed', 'failed']

export function TaskBoard() {
  const tasks = useAppStore((s) => s.tasks)
  const loadTasks = useAppStore((s) => s.loadTasks)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)
  const setEditingTaskId = useAppStore((s) => s.setEditingTaskId)

  useEffect(() => {
    loadTasks()
    loadAgents()
    const interval = setInterval(loadTasks, 5000)
    return () => clearInterval(interval)
  }, [])

  const tasksByStatus = (status: BoardTaskStatus) =>
    Object.values(tasks)
      .filter((t) => t.status === status)
      .sort((a, b) => b.updatedAt - a.updatedAt)

  const handleDrop = useCallback(async (taskId: string, newStatus: BoardTaskStatus) => {
    const task = tasks[taskId]
    if (!task || task.status === newStatus) return
    await updateTask(taskId, { status: newStatus })
    await loadTasks()
  }, [tasks, loadTasks])

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-8 pt-6 pb-4 shrink-0">
        <div>
          <h1 className="font-display text-[28px] font-800 tracking-[-0.03em]">Task Board</h1>
          <p className="text-[13px] text-text-3 mt-1">Create tasks and assign orchestrators to run them sequentially</p>
        </div>
        <button
          onClick={() => {
            setEditingTaskId(null)
            setTaskSheetOpen(true)
          }}
          className="px-5 py-2.5 rounded-[12px] border-none bg-[#6366F1] text-white text-[14px] font-600 cursor-pointer
            hover:brightness-110 active:scale-[0.97] transition-all shadow-[0_2px_12px_rgba(99,102,241,0.2)]"
          style={{ fontFamily: 'inherit' }}
        >
          + New Task
        </button>
      </div>

      <div className="flex-1 flex gap-5 px-8 pb-6 overflow-x-auto overflow-y-hidden">
        {COLUMNS.map((status) => (
          <TaskColumn key={status} status={status} tasks={tasksByStatus(status)} onDrop={handleDrop} />
        ))}
      </div>
    </div>
  )
}
