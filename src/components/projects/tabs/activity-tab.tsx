'use client'

import { useMemo } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { relativeDate, STATUS_STYLES } from '../project-utils'
import type { Agent, BoardTask, Schedule } from '@/types'

const MAX_ITEMS = 50

export function ActivityTab() {
  const tasks = useAppStore((s) => s.tasks) as Record<string, BoardTask>
  const schedules = useAppStore((s) => s.schedules) as Record<string, Schedule>
  const agents = useAppStore((s) => s.agents) as Record<string, Agent>
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)

  const projectAgents = useMemo(
    () => Object.values(agents).filter((a) => a.projectId === activeProjectFilter && !a.trashedAt),
    [agents, activeProjectFilter],
  )

  const projectTasks = useMemo(
    () => Object.values(tasks).filter((t) => t.projectId === activeProjectFilter).sort((a, b) => b.updatedAt - a.updatedAt),
    [tasks, activeProjectFilter],
  )

  const projectSchedules = useMemo(
    () => Object.values(schedules).filter((s) => s.projectId === activeProjectFilter),
    [schedules, activeProjectFilter],
  )

  const activityItems = useMemo(() => {
    const items: { id: string; type: 'task' | 'schedule' | 'agent'; name: string; status?: string; time: number }[] = []
    for (const t of projectTasks) {
      items.push({ id: t.id, type: 'task', name: t.title, status: t.status, time: t.updatedAt })
    }
    for (const s of projectSchedules) {
      if (s.lastRunAt) items.push({ id: s.id, type: 'schedule', name: s.name, status: s.status, time: s.lastRunAt })
    }
    for (const a of projectAgents) {
      if (a.lastUsedAt) items.push({ id: a.id, type: 'agent', name: a.name, time: a.lastUsedAt })
    }
    return items.sort((a, b) => b.time - a.time)
  }, [projectTasks, projectSchedules, projectAgents])

  const displayedItems = activityItems.slice(0, MAX_ITEMS)
  const truncated = activityItems.length > MAX_ITEMS

  if (activityItems.length === 0) {
    return (
      <div className="max-w-3xl mx-auto px-8 py-6">
        <p className="text-[12px] text-text-3/45">No activity yet.</p>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-8 py-6">
      <div className="relative pl-5">
        <div className="absolute left-[7px] top-2 bottom-2 w-px bg-white/[0.06]" />
        <div className="flex flex-col gap-3">
          {displayedItems.map((item) => (
            <div key={`${item.type}-${item.id}`} className="relative flex items-start gap-3">
              <div className={`absolute left-[-13px] top-1.5 w-2 h-2 rounded-full ${
                item.type === 'task' && item.status === 'completed' ? 'bg-emerald-400'
                : item.type === 'task' && item.status === 'running' ? 'bg-sky-400'
                : item.type === 'task' && item.status === 'failed' ? 'bg-red-400'
                : item.type === 'schedule' ? 'bg-amber-400'
                : 'bg-white/[0.2]'
              }`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-600 uppercase tracking-wider text-text-3/40">
                    {item.type}
                  </span>
                  {item.status && (
                    <span className={`text-[9px] font-600 uppercase tracking-wider px-1.5 py-0.5 rounded-[4px] ${STATUS_STYLES[item.status] || 'bg-white/[0.06] text-text-3'}`}>
                      {item.status}
                    </span>
                  )}
                </div>
                <p className="text-[12px] text-text-2 truncate mt-0.5">{item.name}</p>
              </div>
              <span className="text-[10px] text-text-3/30 shrink-0 mt-0.5">{relativeDate(item.time)}</span>
            </div>
          ))}
        </div>
      </div>
      {truncated && (
        <p className="text-[11px] text-text-3/40 text-center mt-4">Showing most recent {MAX_ITEMS} items</p>
      )}
    </div>
  )
}
