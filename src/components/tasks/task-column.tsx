'use client'

import { useState, useCallback } from 'react'
import { TaskCard } from './task-card'
import type { BoardTask, BoardTaskStatus } from '@/types'

const COLUMN_CONFIG: Record<BoardTaskStatus, { label: string; color: string; dot: string }> = {
  backlog: { label: 'Backlog', color: 'text-text-3', dot: 'bg-white/20' },
  queued: { label: 'Queued', color: 'text-amber-400', dot: 'bg-amber-400' },
  running: { label: 'Running', color: 'text-blue-400', dot: 'bg-blue-400' },
  completed: { label: 'Completed', color: 'text-emerald-400', dot: 'bg-emerald-400' },
  failed: { label: 'Failed', color: 'text-red-400', dot: 'bg-red-400' },
}

interface Props {
  status: BoardTaskStatus
  tasks: BoardTask[]
  onDrop: (taskId: string, newStatus: BoardTaskStatus) => void
}

export function TaskColumn({ status, tasks, onDrop }: Props) {
  const config = COLUMN_CONFIG[status]
  const [dragOver, setDragOver] = useState(false)

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

  return (
    <div
      className={`flex-1 min-w-[240px] max-w-[320px] flex flex-col rounded-[16px] transition-colors duration-150 ${
        dragOver ? 'bg-accent-bright/[0.04] ring-1 ring-accent-bright/20' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="flex items-center gap-2.5 px-2 mb-4">
        <div className={`w-2 h-2 rounded-full ${config.dot}`} />
        <span className={`font-display text-[13px] font-600 ${config.color}`}>{config.label}</span>
        <span className="text-[12px] text-text-3 ml-auto">{tasks.length}</span>
      </div>
      <div className="flex flex-col gap-3 flex-1 overflow-y-auto pr-1 px-1 pb-2">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} />
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
