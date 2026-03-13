'use client'

import { useState, useCallback } from 'react'
import { TaskCard } from './task-card'
import { createTask } from '@/lib/tasks'
import { useAppStore } from '@/stores/use-app-store'
import type { BoardTask, BoardTaskStatus } from '@/types'

const COLUMN_CONFIG: Record<BoardTaskStatus, { label: string; color: string; dot: string }> = {
  backlog: { label: 'Backlog', color: 'text-text-3', dot: 'bg-white/20' },
  queued: { label: 'Queued', color: 'text-amber-400', dot: 'bg-amber-400' },
  running: { label: 'Running', color: 'text-blue-400', dot: 'bg-blue-400' },
  completed: { label: 'Completed', color: 'text-emerald-400', dot: 'bg-emerald-400' },
  failed: { label: 'Failed', color: 'text-red-400', dot: 'bg-red-400' },
  cancelled: { label: 'Cancelled', color: 'text-text-3', dot: 'bg-white/20' },
  archived: { label: 'Archived', color: 'text-text-3/50', dot: 'bg-white/10' },
}

interface Props {
  status: BoardTaskStatus
  tasks: BoardTask[]
  onDrop: (taskId: string, newStatus: BoardTaskStatus) => void
  selectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (id: string) => void
  onSelectAll?: () => void
}

export function TaskColumn({ status, tasks, onDrop, selectionMode, selectedIds, onToggleSelect, onSelectAll }: Props) {
  const config = COLUMN_CONFIG[status]
  const [dragOver, setDragOver] = useState(false)
  const [quickAddValue, setQuickAddValue] = useState('')
  const [adding, setAdding] = useState(false)
  const loadTasks = useAppStore((s) => s.loadTasks)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const taskId = e.dataTransfer.getData('text/plain')
    if (taskId) {
      onDrop(taskId, status)
    }
  }, [onDrop, status])

  const handleQuickAdd = async () => {
    const title = quickAddValue.trim()
    if (!title || adding) return
    setAdding(true)
    try {
      await createTask({ title, description: '', agentId: '', status })
      await loadTasks()
      setQuickAddValue('')
    } finally {
      setAdding(false)
    }
  }

  const selectedCount = tasks.filter((t) => selectedIds?.has(t.id)).length

  return (
    <div
      className={`flex-1 min-w-[240px] max-w-[320px] min-h-0 flex flex-col rounded-[16px] transition-colors duration-150 ${
        dragOver ? 'bg-accent-bright/[0.04] ring-1 ring-accent-bright/20' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center gap-2.5 px-2 mb-3">
        <div className={`w-2 h-2 rounded-full ${config.dot}`} />
        <span className={`font-display text-[13px] font-600 ${config.color}`}>{config.label}</span>
        <span className="text-[12px] text-text-3 ml-auto">{tasks.length}</span>
        {selectionMode && tasks.length > 0 && (
          <button
            onClick={onSelectAll}
            className={`text-[10px] font-600 px-1.5 py-0.5 rounded-[5px] cursor-pointer border-none transition-colors
              ${selectedCount === tasks.length && selectedCount > 0
                ? 'bg-accent-bright/20 text-accent-bright'
                : 'bg-white/[0.04] text-text-3 hover:bg-white/[0.08]'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {selectedCount === tasks.length && selectedCount > 0 ? 'All' : 'Select all'}
          </button>
        )}
      </div>

      {/* Quick add input */}
      {(status === 'backlog' || status === 'queued') && (
        <div className="px-1 mb-2">
          <input
            type="text"
            value={quickAddValue}
            onChange={(e) => setQuickAddValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleQuickAdd() }}
            placeholder={`+ Add to ${config.label.toLowerCase()}...`}
            className="w-full px-3 py-2 rounded-[10px] bg-white/[0.02] border border-dashed border-white/[0.08] text-[12px] text-text placeholder:text-text-3/30 outline-none focus:border-white/[0.15] focus:bg-white/[0.03] transition-colors"
            style={{ fontFamily: 'inherit' }}
            disabled={adding}
          />
        </div>
      )}

      <div className="flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto overscroll-y-contain touch-pan-y pr-1 px-1 pb-2">
        {tasks.map((task, idx) => (
          <TaskCard
            key={task.id}
            task={task}
            index={idx}
            selectionMode={selectionMode}
            selected={selectedIds?.has(task.id)}
            onToggleSelect={onToggleSelect}
          />
        ))}
        {tasks.length === 0 && (
          <div className={`text-[12px] text-text-3/50 text-center py-8 rounded-[12px] border border-dashed transition-colors ${
            dragOver ? 'border-accent-bright/30 text-accent-bright/50' : 'border-transparent'
          }`}>
            {dragOver ? 'Drop here' : 'No tasks'}
          </div>
        )}
      </div>
    </div>
  )
}
