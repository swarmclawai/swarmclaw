'use client'

import { useEffect } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import type { BoardTaskStatus } from '@/types'

const STATUS_DOT: Record<BoardTaskStatus, string> = {
  backlog: 'bg-white/20',
  queued: 'bg-amber-400',
  running: 'bg-blue-400 animate-pulse',
  completed: 'bg-emerald-400',
  failed: 'bg-red-400',
}

export function TaskList({ inSidebar }: { inSidebar?: boolean }) {
  const tasks = useAppStore((s) => s.tasks)
  const loadTasks = useAppStore((s) => s.loadTasks)
  const agents = useAppStore((s) => s.agents)
  const setEditingTaskId = useAppStore((s) => s.setEditingTaskId)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)

  useEffect(() => {
    loadTasks()
    const interval = setInterval(loadTasks, 5000)
    return () => clearInterval(interval)
  }, [])

  const sorted = Object.values(tasks).sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <div className="flex-1 overflow-y-auto">
      {sorted.length === 0 && (
        <div className="text-center text-text-3 text-[13px] py-12 px-6">No tasks yet</div>
      )}
      {sorted.map((task) => {
        const agent = agents[task.agentId]
        return (
          <button
            key={task.id}
            onClick={() => {
              setEditingTaskId(task.id)
              setTaskSheetOpen(true)
            }}
            className="w-full text-left px-5 py-3.5 border-none bg-transparent cursor-pointer hover:bg-white/[0.03] transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            <div className="flex items-center gap-2.5">
              <div className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[task.status]}`} />
              <span className="text-[14px] font-600 text-text truncate flex-1">{task.title}</span>
            </div>
            {agent && (
              <span className="text-[11px] text-text-3 ml-[18px]">{agent.name}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
