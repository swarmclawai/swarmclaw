'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import type { Agent, BoardTask, Schedule } from '@/types'

function relativeDate(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

interface ProjectStats {
  agents: number
  tasks: number
  completedTasks: number
  schedules: number
  lastActivity: number
}

export function ProjectList() {
  const projects = useAppStore((s) => s.projects)
  const loadProjects = useAppStore((s) => s.loadProjects)
  const agents = useAppStore((s) => s.agents) as Record<string, Agent>
  const tasks = useAppStore((s) => s.tasks) as Record<string, BoardTask>
  const schedules = useAppStore((s) => s.schedules) as Record<string, Schedule>
  const setProjectSheetOpen = useAppStore((s) => s.setProjectSheetOpen)
  const setEditingProjectId = useAppStore((s) => s.setEditingProjectId)
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)
  const setActiveProjectFilter = useAppStore((s) => s.setActiveProjectFilter)
  const loadTasks = useAppStore((s) => s.loadTasks)
  const loadSchedules = useAppStore((s) => s.loadSchedules)
  const [search, setSearch] = useState('')

  useEffect(() => {
    loadProjects()
    loadTasks()
    loadSchedules()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtered = useMemo(() => {
    return Object.values(projects)
      .filter((p) => {
        if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false
        return true
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [projects, search])

  const statsMap = useMemo(() => {
    const map: Record<string, ProjectStats> = {}
    for (const p of Object.values(projects)) {
      map[p.id] = { agents: 0, tasks: 0, completedTasks: 0, schedules: 0, lastActivity: p.updatedAt }
    }
    for (const a of Object.values(agents)) {
      if (a.projectId && map[a.projectId]) {
        map[a.projectId].agents++
        if (a.updatedAt && a.updatedAt > map[a.projectId].lastActivity) {
          map[a.projectId].lastActivity = a.updatedAt
        }
      }
    }
    for (const t of Object.values(tasks)) {
      if (t.projectId && map[t.projectId]) {
        map[t.projectId].tasks++
        if (t.status === 'completed') map[t.projectId].completedTasks++
        if (t.updatedAt && t.updatedAt > map[t.projectId].lastActivity) {
          map[t.projectId].lastActivity = t.updatedAt
        }
      }
    }
    for (const s of Object.values(schedules)) {
      if (s.projectId && map[s.projectId]) {
        map[s.projectId].schedules++
      }
    }
    return map
  }, [projects, agents, tasks, schedules])

  // Summary stats
  const totalProjects = Object.keys(projects).length
  const totalTasks = Object.values(tasks).filter((t) => t.projectId).length
  const totalCompleted = Object.values(tasks).filter((t) => t.projectId && t.status === 'completed').length

  if (!filtered.length && !search) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-text-3 p-8 text-center" style={{ animation: 'fade-up 0.5s var(--ease-spring)' }}>
        <div className="w-14 h-14 rounded-[16px] bg-accent-soft flex items-center justify-center mb-1">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-accent-bright">
            <path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7-7H4a2 2 0 0 0-2 2v17Z" />
            <path d="M14 2v7h7" />
          </svg>
        </div>
        <p className="font-display text-[16px] font-600 text-text-2">No projects yet</p>
        <p className="text-[13px] text-text-3/60 max-w-[280px]">
          Projects group your agents, tasks, and schedules together. Create one to get organized.
        </p>
        <button
          onClick={() => { setEditingProjectId(null); setProjectSheetOpen(true) }}
          className="inline-flex items-center gap-1.5 px-5 py-2.5 text-[13px] font-600 text-white bg-accent-bright rounded-[10px] hover:brightness-110 transition-all cursor-pointer border-none"
          style={{ fontFamily: 'inherit' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Project
        </button>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header with search and new button */}
      <div className="px-5 pt-5 pb-3 shrink-0" style={{ animation: 'fade-up 0.4s var(--ease-spring)' }}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="font-display text-[20px] font-700 text-text tracking-[-0.02em]">Projects</h2>
            <p className="text-[12px] text-text-3/60 mt-0.5">
              {totalProjects} project{totalProjects !== 1 ? 's' : ''}
              {totalTasks > 0 && <> &middot; {totalCompleted}/{totalTasks} tasks done</>}
            </p>
          </div>
          <button
            onClick={() => { setEditingProjectId(null); setProjectSheetOpen(true) }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-[12px] font-600 text-white bg-accent-bright rounded-[10px] hover:brightness-110 transition-all cursor-pointer border-none"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New
          </button>
        </div>

        {/* Search */}
        <div className="relative">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-text-3/50">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects..."
            className="w-full pl-9 pr-3 py-2.5 rounded-[10px] bg-white/[0.04] border border-white/[0.06] text-[13px] text-text placeholder:text-text-3/40 focus:outline-none focus:border-accent-bright/30 transition-colors"
            style={{ fontFamily: 'inherit' }}
          />
        </div>
      </div>

      {/* Project cards */}
      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="grid gap-3">
          {filtered.map((project, idx) => {
            const stats = statsMap[project.id] || { agents: 0, tasks: 0, completedTasks: 0, schedules: 0, lastActivity: project.updatedAt }
            const isActive = activeProjectFilter === project.id
            const progressPct = stats.tasks > 0 ? Math.round((stats.completedTasks / stats.tasks) * 100) : 0

            return (
              <div
                key={project.id}
                className={`group relative rounded-[14px] border transition-all duration-200 cursor-pointer overflow-hidden
                  ${isActive
                    ? 'bg-white/[0.06] border-accent-bright/30 shadow-[0_0_20px_rgba(99,102,241,0.08)]'
                    : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.05] hover:border-white/[0.1] hover:scale-[1.01]'}`}
                onClick={() => setActiveProjectFilter(isActive ? null : project.id)}
                style={{
                  animation: 'fade-up 0.4s var(--ease-spring) both',
                  animationDelay: `${0.1 + idx * 0.03}s`
                }}
              >
                {/* Color accent stripe */}
                <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-[14px]" style={{ backgroundColor: project.color || '#6B7280', animation: 'spring-in 0.6s var(--ease-spring)' }} />

                <div className="pl-5 pr-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-display text-[14px] font-600 text-text truncate">{project.name}</h3>
                        {isActive && (
                          <span className="shrink-0 text-[9px] font-700 uppercase tracking-wider text-accent-bright bg-accent-soft px-1.5 py-0.5 rounded-[5px]" style={{ animation: 'spring-in 0.3s var(--ease-spring)' }}>
                            active filter
                          </span>
                        )}
                      </div>
                      {project.description && (
                        <p className="text-[12px] text-text-3/60 mt-1 line-clamp-2 leading-relaxed">{project.description}</p>
                      )}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); setEditingProjectId(project.id); setProjectSheetOpen(true) }}
                      className="opacity-0 group-hover:opacity-100 p-1.5 rounded-[8px] hover:bg-white/[0.08] transition-all text-text-3/50 hover:text-text-2 cursor-pointer bg-transparent border-none shrink-0"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      </svg>
                    </button>
                  </div>

                  {/* Stats row */}
                  <div className="flex items-center gap-4 mt-3 text-[11px] text-text-3/50">
                    <span className="flex items-center gap-1.5">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                        <circle cx="9" cy="7" r="4" />
                      </svg>
                      {stats.agents} agent{stats.agents !== 1 ? 's' : ''}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M9 11l3 3L22 4" />
                        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                      </svg>
                      {stats.completedTasks}/{stats.tasks} task{stats.tasks !== 1 ? 's' : ''}
                    </span>
                    {stats.schedules > 0 && (
                      <span className="flex items-center gap-1.5">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <circle cx="12" cy="12" r="10" />
                          <polyline points="12 6 12 12 16 14" />
                        </svg>
                        {stats.schedules} schedule{stats.schedules !== 1 ? 's' : ''}
                      </span>
                    )}
                    <span className="ml-auto text-text-3/40">
                      {relativeDate(stats.lastActivity)}
                    </span>
                  </div>

                  {/* Progress bar */}
                  {stats.tasks > 0 && (
                    <div className="mt-3 flex items-center gap-2.5">
                      <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden relative">
                        <div
                          className="h-full rounded-full transition-all duration-500 relative"
                          style={{
                            width: `${progressPct}%`,
                            backgroundColor: progressPct === 100 ? '#22C55E' : (project.color || '#6366F1'),
                          }}
                        >
                          {isActive && progressPct < 100 && (
                            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full animate-[shimmer-bar_2s_infinite]" />
                          )}
                        </div>
                      </div>
                      <span className={`text-[10px] font-mono font-600 ${progressPct === 100 ? 'text-emerald-400' : 'text-text-3/50'}`}>
                        {progressPct}%
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
