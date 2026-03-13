'use client'

import { useState, useCallback, useEffect } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useNavigate } from '@/lib/app/navigation'
import { updateTask, archiveTask } from '@/lib/tasks'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { timeAgo } from '@/lib/time-format'
import { InfoChip } from '@/components/ui/info-chip'
import type { BoardTask } from '@/types'

interface TaskCardProps {
  task: BoardTask
  selectionMode?: boolean
  selected?: boolean
  onToggleSelect?: (id: string) => void
  index?: number
}

export function TaskCard({ task, selectionMode, selected, onToggleSelect, index = 0 }: TaskCardProps) {
  const agents = useAppStore((s) => s.agents)
  const projects = useAppStore((s) => s.projects)
  const setEditingTaskId = useAppStore((s) => s.setEditingTaskId)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)
  const loadTasks = useAppStore((s) => s.loadTasks)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)
  const navigateTo = useNavigate()
  const [dragging, setDragging] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [allowDrag, setAllowDrag] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (typeof window === 'undefined') return
    const frame = window.requestAnimationFrame(() => {
      const isCoarsePointer = typeof window.matchMedia === 'function'
        ? window.matchMedia('(pointer: coarse)').matches
        : 'ontouchstart' in window
      setAllowDrag(!isCoarsePointer)
    })
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearInterval(timer)
    }
  }, [])

  const tasks = useAppStore((s) => s.tasks)
  const agent = agents[task.agentId]
  const project = task.projectId ? projects[task.projectId] : null
  const creatorAgent = task.createdByAgentId ? agents[task.createdByAgentId] : null
  const delegatorAgent = task.delegatedByAgentId ? agents[task.delegatedByAgentId] : null
  const githubSource = task.externalSource?.source === 'github' ? task.externalSource : null

  const priorityConfig = {
    critical: { label: 'Critical', cls: 'bg-red-500/10 text-red-400' },
    high: { label: 'High', cls: 'bg-orange-500/10 text-orange-400' },
    medium: { label: 'Med', cls: 'bg-amber-500/10 text-amber-400' },
    low: { label: 'Low', cls: 'bg-sky-500/10 text-sky-400' },
  } as const
  const prio = task.priority && priorityConfig[task.priority]

  const isBlocked = Array.isArray(task.blockedBy) && task.blockedBy.length > 0
  const isOverdue = task.dueAt
    && task.dueAt < now
    && task.status !== 'completed'
    && task.status !== 'failed'
    && task.status !== 'cancelled'
    && task.status !== 'archived'
  const borderColor = isBlocked ? 'border-l-rose-500'
    : task.status === 'running' ? 'border-l-emerald-500'
    : task.status === 'failed' ? 'border-l-red-500'
    : task.status === 'cancelled' ? 'border-l-white/15'
    : 'border-l-transparent'

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
    if (task.agentId) {
      void setCurrentAgent(task.agentId)
      navigateTo('agents')
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
      draggable={!selectionMode && allowDrag}
      onDragStart={selectionMode || !allowDrag ? undefined : handleDragStart}
      onDragEnd={selectionMode || !allowDrag ? undefined : handleDragEnd}
      onClick={(e) => {
        if (selectionMode && onToggleSelect) {
          e.stopPropagation()
          onToggleSelect(task.id)
        } else {
          setEditingTaskId(task.id)
          setTaskSheetOpen(true)
        }
      }}
      className={`py-3 px-4 rounded-[14px] border border-l-[3px] ${borderColor} bg-surface hover:bg-surface-2 transition-all group
        ${selectionMode || !allowDrag ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'} touch-pan-y
        ${dragging ? 'opacity-40 scale-[0.97]' : ''}
        ${selected ? 'border-accent-bright/40 bg-accent-bright/[0.04] ring-1 ring-accent-bright/20 shadow-lg' : 'border-white/[0.06] hover:border-white/[0.12] hover:scale-[1.01] hover:shadow-md'}`}
      style={{
        animation: 'spring-in 0.5s var(--ease-spring) both',
        animationDelay: `${Math.min(index * 0.05, 0.4)}s`
      }}
    >
      <div className="flex items-start gap-3 mb-3">
        {/* Selection checkbox */}
        {(selectionMode || selected) && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleSelect?.(task.id) }}
            className={`w-5 h-5 rounded-[6px] border-2 flex items-center justify-center shrink-0 mt-0.5 cursor-pointer transition-all
              ${selected
                ? 'bg-accent-bright border-accent-bright'
                : 'bg-transparent border-white/[0.2] hover:border-white/[0.4]'}`}
            style={{ padding: 0, fontFamily: 'inherit' }}
          >
            {selected && (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round"><path d="M20 6L9 17l-5-5" /></svg>
            )}
          </button>
        )}
        {isBlocked && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-rose-400 shrink-0 mt-0.5">
            <title>{`Blocked by: ${(task.blockedBy || []).map((bid) => tasks[bid]?.title || bid).join(', ')}`}</title>
            <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        )}
        <h4 className="flex-1 text-[14px] font-600 text-text leading-[1.4] line-clamp-2">{task.title}</h4>
        {prio && (
          <span className={`px-1.5 py-0.5 rounded-[5px] text-[10px] font-600 shrink-0 ${prio.cls}`}>
            {prio.label}
          </span>
        )}
        {isBlocked && (
          <span className="px-1.5 py-0.5 rounded-[5px] bg-rose-500/10 text-rose-400 text-[10px] font-600 shrink-0">
            {task.blockedBy?.length}
          </span>
        )}
      </div>

      {task.description && (
        <p className="text-[12px] text-text-3 line-clamp-2 mb-3">{task.description}</p>
      )}

      {/* Tags */}
      {task.tags && task.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {task.tags.map((tag) => (
            <span key={tag} className="px-1.5 py-0.5 rounded-[5px] bg-indigo-500/10 text-indigo-400 text-[10px] font-600">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Due date */}
      {task.dueAt && (
        <p className={`text-[11px] mb-3 font-600 ${isOverdue ? 'text-red-400' : 'text-text-3/60'}`}>
          Due {new Date(task.dueAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
          {isOverdue && ' (overdue)'}
        </p>
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
      {task.sourceType === 'schedule' && (
        <div className="flex items-center gap-2 mb-3 text-[11px] text-text-3">
          <span className="px-1.5 py-0.5 rounded-[5px] bg-purple-500/10 text-purple-400 font-600">
            Run #{task.runNumber || 1}
          </span>
          {(task.totalRuns ?? 0) > 0 && (
            <>
              <span title="Total runs">{task.totalRuns} runs</span>
              {(task.totalCompleted ?? 0) > 0 && (
                <span className="text-green-400" title="Completed">{task.totalCompleted} ok</span>
              )}
              {(task.totalFailed ?? 0) > 0 && (
                <span className="text-red-400" title="Failed">{task.totalFailed} fail</span>
              )}
            </>
          )}
        </div>
      )}

      {(creatorAgent || delegatorAgent || task.sourceType === 'schedule' || githubSource) && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {delegatorAgent && (
            <InfoChip tone="warning">
              <AgentAvatar seed={delegatorAgent.avatarSeed} avatarUrl={delegatorAgent.avatarUrl} name={delegatorAgent.name} size={14} />
              Delegated by {delegatorAgent.name}
            </InfoChip>
          )}
          {creatorAgent && creatorAgent.id !== delegatorAgent?.id && (
            <InfoChip tone="neutral">
              <AgentAvatar seed={creatorAgent.avatarSeed} avatarUrl={creatorAgent.avatarUrl} name={creatorAgent.name} size={14} />
              Created by {creatorAgent.name}
            </InfoChip>
          )}
          {task.sourceType === 'schedule' && (
            <InfoChip tone="purple">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="8" />
                <path d="M12 8v4l3 2" />
              </svg>
              {task.sourceScheduleName ? `Scheduled via ${task.sourceScheduleName}` : 'Scheduled task'}
            </InfoChip>
          )}
          {githubSource && (
            githubSource.url ? (
              <a
                href={githubSource.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1.5 rounded-[7px] bg-sky-500/10 px-2 py-1 text-[10px] font-600 text-sky-300 hover:bg-sky-500/15"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
                  <path d="M12 .5C5.65.5.5 5.65.5 12A11.5 11.5 0 0 0 8.36 22.9c.57.1.78-.25.78-.55 0-.27-.01-1.17-.02-2.13-3.2.69-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.45.11-3.02 0 0 .96-.31 3.15 1.17a10.9 10.9 0 0 1 5.73 0c2.18-1.48 3.14-1.17 3.14-1.17.63 1.57.24 2.73.12 3.02.74.8 1.18 1.82 1.18 3.07 0 4.41-2.7 5.38-5.27 5.66.42.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.2.66.79.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
                </svg>
                {githubSource.repo ? `${githubSource.repo}#${githubSource.number}` : `GitHub #${githubSource.number ?? githubSource.id}`}
              </a>
            ) : (
              <InfoChip tone="info">
                GitHub {githubSource.repo ? `${githubSource.repo}#${githubSource.number}` : `#${githubSource.number ?? githubSource.id}`}
              </InfoChip>
            )
          )}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {agent && (
          <span className="px-2 py-1 rounded-[6px] bg-accent-soft text-accent-bright text-[11px] font-600">
            {agent.name}
          </span>
        )}
        {project && (
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-[6px] bg-white/[0.04] text-text-2 text-[11px] font-600">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: project.color || '#6366F1' }} />
            {project.name}
          </span>
        )}
        <span className="text-[11px] text-text-3">{timeAgo(task.updatedAt, now)}</span>
        {task.comments && task.comments.length > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-text-3">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/60">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            {task.comments.length}
          </span>
        )}
        {Array.isArray(task.blocks) && task.blocks.length > 0 && (
          <span
            className="px-1.5 py-0.5 rounded-[5px] bg-amber-500/10 text-amber-400 text-[10px] font-600"
            title={`Blocks: ${task.blocks.map((bid) => tasks[bid]?.title || bid).join(', ')}`}
          >
            blocks {task.blocks.length}
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

        {task.sessionId && (task.status === 'running' || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') && (
          <button
            onClick={handleViewSession}
            className="ml-auto px-2.5 py-1 rounded-[8px] text-[11px] font-600 bg-white/[0.06] text-text-2 border-none cursor-pointer
              opacity-0 group-hover:opacity-100 transition-opacity hover:bg-white/[0.1]"
            style={{ fontFamily: 'inherit' }}
          >
            View
          </button>
        )}

        {(task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') && !task.sessionId && (
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmArchive(true) }}
            aria-label="Archive task"
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
      <ConfirmDialog
        open={confirmArchive}
        title="Archive Task"
        message={`Archive "${task.title}"? You can view archived tasks later.`}
        confirmLabel="Archive"
        onConfirm={() => { setConfirmArchive(false); handleArchive({ stopPropagation: () => {} } as React.MouseEvent) }}
        onCancel={() => setConfirmArchive(false)}
      />
    </div>
  )
}
