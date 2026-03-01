'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import { api } from '@/lib/api-client'
import type { BoardTaskStatus } from '@/types'

const STATUS_DOT: Record<BoardTaskStatus, string> = {
  backlog: 'bg-white/20',
  queued: 'bg-amber-400',
  running: 'bg-blue-400 animate-pulse',
  completed: 'bg-emerald-400',
  failed: 'bg-red-400',
  archived: 'bg-white/10',
}

export function TaskList({ inSidebar }: { inSidebar?: boolean }) {
  const tasks = useAppStore((s) => s.tasks)
  const loadTasks = useAppStore((s) => s.loadTasks)
  const agents = useAppStore((s) => s.agents)
  const setEditingTaskId = useAppStore((s) => s.setEditingTaskId)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)
  const [search, setSearch] = useState('')
  const [clearing, setClearing] = useState(false)

  useEffect(() => { loadTasks() }, [])
  useWs('tasks', loadTasks, 5000)

  const sorted = useMemo(() =>
    Object.values(tasks)
      .filter((t) => !activeProjectFilter || t.projectId === activeProjectFilter)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    [tasks, activeProjectFilter],
  )

  const filtered = useMemo(() => {
    if (!search.trim()) return sorted
    const q = search.toLowerCase()
    return sorted.filter((t) => {
      const agent = agents[t.agentId]
      return t.title.toLowerCase().includes(q)
        || t.status.includes(q)
        || agent?.name.toLowerCase().includes(q)
    })
  }, [sorted, search, agents])

  const doneCount = useMemo(() =>
    sorted.filter((t) => t.status === 'completed' || t.status === 'failed').length,
    [sorted],
  )

  const handleClearDone = async () => {
    setClearing(true)
    try {
      await api('DELETE', '/tasks?filter=done')
      await loadTasks()
    } catch { /* silent */ }
    setClearing(false)
  }

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      {/* Search + clear */}
      {sorted.length > 0 && (
        <div className="px-3 py-2 shrink-0 flex flex-col gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks..."
            className="w-full px-3 py-2 rounded-[10px] border border-white/[0.04] bg-surface text-text
              text-[12px] outline-none transition-all duration-200 placeholder:text-text-3/70 focus-glow"
            style={{ fontFamily: 'inherit' }}
          />
          {doneCount > 0 && (
            <button
              onClick={() => { void handleClearDone() }}
              disabled={clearing}
              className="w-full py-1.5 rounded-[8px] border border-white/[0.06] bg-transparent text-text-3 text-[11px] font-600 cursor-pointer hover:text-red-400 hover:border-red-400/20 hover:bg-red-400/[0.04] disabled:opacity-40 transition-all"
              style={{ fontFamily: 'inherit' }}
            >
              {clearing ? 'Clearing...' : `Clear ${doneCount} completed/failed`}
            </button>
          )}
        </div>
      )}

      {filtered.length === 0 && (
        <div className="text-center text-text-3 text-[13px] py-12 px-6">
          {sorted.length === 0 ? 'No tasks yet' : 'No matching tasks'}
        </div>
      )}
      {filtered.map((task) => {
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
