'use client'

import { useEffect, useCallback, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { updateTask } from '@/lib/tasks'
import { TaskColumn } from './task-column'
import type { BoardTaskStatus } from '@/types'

const ACTIVE_COLUMNS: BoardTaskStatus[] = ['backlog', 'queued', 'running', 'completed', 'failed']

export function TaskBoard() {
  const tasks = useAppStore((s) => s.tasks)
  const loadTasks = useAppStore((s) => s.loadTasks)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)
  const setEditingTaskId = useAppStore((s) => s.setEditingTaskId)
  const agents = useAppStore((s) => s.agents)
  const showArchived = useAppStore((s) => s.showArchivedTasks)
  const setShowArchived = useAppStore((s) => s.setShowArchivedTasks)
  const [filterAgentId, setFilterAgentId] = useState<string>('')

  useEffect(() => {
    loadTasks()
    loadAgents()
    const interval = setInterval(loadTasks, 5000)
    return () => clearInterval(interval)
  }, [])

  const columns: BoardTaskStatus[] = showArchived ? [...ACTIVE_COLUMNS, 'archived'] : ACTIVE_COLUMNS

  const tasksByStatus = (status: BoardTaskStatus) =>
    Object.values(tasks)
      .filter((t) => t.status === status && (!filterAgentId || t.agentId === filterAgentId))
      .sort((a, b) => b.updatedAt - a.updatedAt)

  const handleDrop = useCallback(async (taskId: string, newStatus: BoardTaskStatus) => {
    const task = tasks[taskId]
    if (!task || task.status === newStatus) return
    await updateTask(taskId, { status: newStatus })
    await loadTasks()
  }, [tasks, loadTasks])

  const archivedCount = Object.values(tasks).filter((t) => t.status === 'archived').length

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-8 pt-6 pb-4 shrink-0">
        <div>
          <h1 className="font-display text-[28px] font-800 tracking-[-0.03em]">Task Board</h1>
          <p className="text-[13px] text-text-3 mt-1">Create tasks and assign orchestrators to run them sequentially</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={filterAgentId}
            onChange={(e) => setFilterAgentId(e.target.value)}
            className="px-3 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
              bg-transparent border-white/[0.06] text-text-3 hover:bg-white/[0.03] appearance-none"
            style={{ fontFamily: 'inherit', minWidth: 130 }}
          >
            <option value="">All Agents</option>
            {Object.values(agents).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <button
            onClick={() => setShowArchived(!showArchived)}
            className={`px-4 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
              ${showArchived
                ? 'bg-white/[0.06] border-white/[0.1] text-text-2'
                : 'bg-transparent border-white/[0.06] text-text-3 hover:bg-white/[0.03]'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {showArchived ? 'Hide' : 'Show'} Archived{!showArchived && archivedCount > 0 ? '' : ''}
          </button>
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
      </div>

      <div className="flex-1 flex gap-5 px-8 pb-6 overflow-x-auto overflow-y-hidden">
        {columns.map((status) => (
          <TaskColumn key={status} status={status} tasks={tasksByStatus(status)} onDrop={handleDrop} />
        ))}
      </div>
    </div>
  )
}
