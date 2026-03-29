'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { relativeDate } from '../project-utils'
import type { BoardTask, Project, Schedule } from '@/types'

interface OverviewTabProps {
  project: Project
}

export function OverviewTab({ project }: OverviewTabProps) {
  const tasks = useAppStore((s) => s.tasks) as Record<string, BoardTask>
  const schedules = useAppStore((s) => s.schedules) as Record<string, Schedule>
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const projectTasks = useMemo(
    () => Object.values(tasks).filter((t) => t.projectId === activeProjectFilter),
    [tasks, activeProjectFilter],
  )

  const projectSchedules = useMemo(
    () => Object.values(schedules).filter((s) => s.projectId === activeProjectFilter),
    [schedules, activeProjectFilter],
  )

  const failedCount = useMemo(() => projectTasks.filter((t) => t.status === 'failed').length, [projectTasks])
  const blockedCount = useMemo(() => projectTasks.filter((t) => (t.blockedBy?.length || 0) > 0).length, [projectTasks])
  const overdueCount = useMemo(() => {
    const overdueTasks = projectTasks.filter((t) => !!t.dueAt && t.dueAt < now && t.status !== 'completed' && t.status !== 'archived').length
    const overdueSchedules = projectSchedules.filter((s) => s.status === 'active' && !!s.nextRunAt && s.nextRunAt < now).length
    return overdueTasks + overdueSchedules
  }, [now, projectTasks, projectSchedules])
  const staleCount = useMemo(
    () => projectTasks.filter((t) => t.status !== 'completed' && t.status !== 'archived' && now - t.updatedAt > 3 * 24 * 60 * 60 * 1000).length,
    [now, projectTasks],
  )

  const actionableTasks = projectTasks.filter((t) => t.status !== 'cancelled' && t.status !== 'archived')
  const completedTasks = actionableTasks.filter((t) => t.status === 'completed').length
  const totalTasks = actionableTasks.length
  const progressPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0

  const tasksByStatus = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const t of projectTasks) {
      counts[t.status] = (counts[t.status] || 0) + 1
    }
    return counts
  }, [projectTasks])

  const healthCards = [
    { label: 'Failed', value: failedCount, tone: 'text-orange-400', hint: 'Tasks that need repair' },
    { label: 'Blocked', value: blockedCount, tone: 'text-rose-400', hint: 'Tasks waiting on dependencies' },
    { label: 'Overdue', value: overdueCount, tone: 'text-red-400', hint: 'Tasks or schedules behind plan' },
    { label: 'Stale', value: staleCount, tone: 'text-sky-400', hint: 'No meaningful progress in 3+ days' },
  ]

  return (
    <div className="max-w-3xl mx-auto px-8 py-6 space-y-6">
      {/* Section 1: Project Identity */}
      {(project.objective || project.audience) && (
        <div className="space-y-3">
          {project.objective && (
            <div>
              <div className="text-[11px] font-600 text-text-3/50 mb-1">Objective</div>
              <p className="text-[13px] text-text leading-relaxed">{project.objective}</p>
            </div>
          )}
          {project.audience && (
            <div>
              <div className="text-[11px] font-600 text-text-3/50 mb-1">Audience</div>
              <p className="text-[13px] text-text-2/80 leading-relaxed">{project.audience}</p>
            </div>
          )}
        </div>
      )}

      {/* Section 2: Health Grid */}
      <div>
        <h3 className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/60 mb-3">Health</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {healthCards.map((card) => {
            const isZero = card.value === 0
            return (
              <div
                key={card.label}
                className={`rounded-[12px] border border-white/[0.06] px-4 py-3 transition-opacity ${isZero ? 'opacity-40' : 'bg-surface/60'}`}
              >
                <div className={`text-[22px] font-display font-700 tracking-[-0.02em] ${isZero ? 'text-text-3/50' : card.tone}`}>
                  {card.value}
                </div>
                <div className="text-[11px] font-600 text-text-2 mt-0.5">{card.label}</div>
                <p className="text-[10px] text-text-3/45 mt-1 leading-relaxed">{card.hint}</p>
              </div>
            )
          })}
        </div>
      </div>

      {/* Section 3: Progress */}
      {totalTasks > 0 && (
        <div className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-5 py-4">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[12px] font-600 text-text-2">Overall Progress</span>
            <span className={`text-[13px] font-mono font-700 ${progressPct === 100 ? 'text-emerald-400' : 'text-text-2'}`}>
              {progressPct}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{
                width: `${progressPct}%`,
                backgroundColor: progressPct === 100 ? '#22C55E' : (project.color || '#6366F1'),
              }}
            />
          </div>
          <div className="flex items-center gap-4 mt-3 text-[10px] text-text-3/40">
            {Object.entries(tasksByStatus).map(([status, count]) => (
              <span key={status} className="flex items-center gap-1">
                <span className={`w-1.5 h-1.5 rounded-full ${
                  status === 'completed' ? 'bg-emerald-400'
                  : status === 'running' ? 'bg-sky-400'
                  : status === 'queued' ? 'bg-amber-400'
                  : status === 'failed' ? 'bg-red-400'
                  : 'bg-white/[0.2]'
                }`} />
                {count} {status}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
