'use client'

import { useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { updateTask, archiveTask } from '@/lib/tasks'
import type { BoardTask, BoardTaskStatus } from '@/types'

function timeAgo(ts: number) {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}

export function TaskCard({ task }: { task: BoardTask }) {
  const agents = useAppStore((s) => s.agents)
  const setEditingTaskId = useAppStore((s) => s.setEditingTaskId)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)
  const loadTasks = useAppStore((s) => s.loadTasks)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const [dragging, setDragging] = useState(false)

  const agent = agents[task.agentId]

  const handleQueue = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await updateTask(task.id, { status: 'queued' })
    await loadTasks()
  }

  const handleArchive = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await archiveTask(task.id)
    await loadTasks()
  }

  const handleViewSession = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (task.sessionId) {
      setCurrentSession(task.sessionId)
      setActiveView('sessions')
    }
  }

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', task.id)
    e.dataTransfer.effectAllowed = 'move'
    setDragging(true)
  }, [task.id])

  const handleDragEnd = useCallback(() => {
    setDragging(false)
  }, [])

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={() => {
        setEditingTaskId(task.id)
        setTaskSheetOpen(true)
      }}
      className={`p-4 rounded-[14px] border border-white/[0.06] bg-surface hover:bg-surface-2 cursor-grab active:cursor-grabbing
        transition-all group ${dragging ? 'opacity-40 scale-[0.97]' : ''}`}
    >
      <div className="flex items-start gap-3 mb-3">
        <h4 className="flex-1 text-[14px] font-600 text-text leading-[1.4] line-clamp-2">{task.title}</h4>
      </div>

      {task.description && (
        <p className="text-[12px] text-text-3 line-clamp-2 mb-3">{task.description}</p>
      )}

      {task.images && task.images.length > 0 && (
        <div className="flex gap-1.5 mb-3 overflow-x-auto">
          {task.images.slice(0, 3).map((url, i) => (
            <img key={i} src={url} alt="" className="w-12 h-12 rounded-[8px] object-cover border border-white/[0.06] shrink-0" />
          ))}
          {task.images.length > 3 && (
            <span className="w-12 h-12 rounded-[8px] bg-surface-2 border border-white/[0.06] flex items-center justify-center text-[11px] text-text-3 font-600 shrink-0">
              +{task.images.length - 3}
            </span>
          )}
        </div>
      )}

      {/* Schedule run stats */}
      {(task as any).sourceType === 'schedule' && (
        <div className="flex items-center gap-2 mb-3 text-[11px] text-text-3">
          <span className="px-1.5 py-0.5 rounded-[5px] bg-purple-500/10 text-purple-400 font-600">
            Run #{task.runNumber || 1}
          </span>
          {((task as any).totalRuns ?? 0) > 0 && (
            <>
              <span title="Total runs">{(task as any).totalRuns} runs</span>
              {((task as any).totalCompleted ?? 0) > 0 && (
                <span className="text-green-400" title="Completed">{(task as any).totalCompleted} ok</span>
              )}
              {((task as any).totalFailed ?? 0) > 0 && (
                <span className="text-red-400" title="Failed">{(task as any).totalFailed} fail</span>
              )}
            </>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {agent && (
          <span className="px-2 py-1 rounded-[6px] bg-accent-soft text-accent-bright text-[11px] font-600">
            {agent.name}
          </span>
        )}
        <span className="text-[11px] text-text-3">{timeAgo(task.updatedAt)}</span>
        {task.comments && task.comments.length > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-text-3">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/60">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            {task.comments.length}
          </span>
        )}

        {task.status === 'backlog' && (
          <button
            onClick={handleQueue}
            className="ml-auto px-2.5 py-1 rounded-[8px] text-[11px] font-600 bg-amber-500/10 text-amber-400 border-none cursor-pointer
              opacity-0 group-hover:opacity-100 transition-opacity hover:bg-amber-500/20"
            style={{ fontFamily: 'inherit' }}
          >
            Queue
          </button>
        )}

        {task.sessionId && (task.status === 'running' || task.status === 'completed') && (
          <button
            onClick={handleViewSession}
            className="ml-auto px-2.5 py-1 rounded-[8px] text-[11px] font-600 bg-white/[0.06] text-text-2 border-none cursor-pointer
              opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white/[0.1]"
            style={{ fontFamily: 'inherit' }}
          >
            View
          </button>
        )}

        {(task.status === 'completed' || task.status === 'failed') && !task.sessionId && (
          <button
            onClick={handleArchive}
            className="ml-auto px-2.5 py-1 rounded-[8px] text-[11px] font-600 bg-white/[0.04] text-text-3 border-none cursor-pointer
              opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white/[0.08]"
            style={{ fontFamily: 'inherit' }}
          >
            Archive
          </button>
        )}
      </div>

      {task.error && (
        <p className="mt-2 text-[11px] text-red-400/80 line-clamp-2">{task.error}</p>
      )}

      {/* Inline comments — show latest 2 */}
      {task.comments && task.comments.length > 0 && (
        <div className="mt-3 pt-3 border-t border-white/[0.04] space-y-2">
          {task.comments.slice(-2).map((c) => (
            <div key={c.id} className="flex gap-2">
              <span className={`text-[11px] font-600 shrink-0 ${c.agentId ? 'text-accent-bright' : 'text-text-2'}`}>
                {c.author}:
              </span>
              <p className="text-[11px] text-text-3 line-clamp-2 leading-[1.5]">{c.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
