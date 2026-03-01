'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'

export function ProjectList() {
  const projects = useAppStore((s) => s.projects)
  const loadProjects = useAppStore((s) => s.loadProjects)
  const agents = useAppStore((s) => s.agents)
  const tasks = useAppStore((s) => s.tasks)
  const setProjectSheetOpen = useAppStore((s) => s.setProjectSheetOpen)
  const setEditingProjectId = useAppStore((s) => s.setEditingProjectId)
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)
  const setActiveProjectFilter = useAppStore((s) => s.setActiveProjectFilter)
  const [search, setSearch] = useState('')

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadProjects() }, [])

  const filtered = useMemo(() => {
    return Object.values(projects)
      .filter((p) => {
        if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false
        return true
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [projects, search])

  const entityCounts = useMemo(() => {
    const counts: Record<string, { agents: number; tasks: number }> = {}
    for (const p of Object.values(projects)) {
      counts[p.id] = { agents: 0, tasks: 0 }
    }
    for (const a of Object.values(agents)) {
      if (a.projectId && counts[a.projectId]) counts[a.projectId].agents++
    }
    for (const t of Object.values(tasks)) {
      if (t.projectId && counts[t.projectId]) counts[t.projectId].tasks++
    }
    return counts
  }, [projects, agents, tasks])

  if (!filtered.length && !search) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 text-text-3 p-8 text-center">
        <div className="w-12 h-12 rounded-[14px] bg-accent-soft flex items-center justify-center mb-1">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-accent-bright">
            <path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7-7H4a2 2 0 0 0-2 2v17Z" />
            <path d="M14 2v7h7" />
          </svg>
        </div>
        <p className="font-display text-[15px] font-600 text-text-2">No projects yet</p>
        <p className="text-[13px] text-text-3/50">Group agents, tasks, and schedules into projects</p>
        <button
          onClick={() => { setEditingProjectId(null); setProjectSheetOpen(true) }}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-500 text-white bg-accent rounded-lg hover:bg-accent-bright transition-colors"
        >
          <span className="text-lg leading-none">+</span> New Project
        </button>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto">
      <div className="p-4 pb-0">
        <div className="flex items-center gap-2 mb-4">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects..."
            className="flex-1 px-3 py-2 rounded-lg bg-white/[0.06] border border-white/[0.06] text-[13px] text-text-1 placeholder:text-text-3/40 focus:outline-none focus:border-accent/40"
            style={{ fontFamily: 'inherit' }}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
        {filtered.map((project) => {
          const counts = entityCounts[project.id] || { agents: 0, tasks: 0 }
          const isActive = activeProjectFilter === project.id
          return (
            <div
              key={project.id}
              className={`group relative p-4 rounded-xl border transition-colors cursor-pointer ${
                isActive
                  ? 'bg-accent/10 border-accent/30'
                  : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.06]'
              }`}
              onClick={() => setActiveProjectFilter(isActive ? null : project.id)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  {project.color && (
                    <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: project.color }} />
                  )}
                  <div className="min-w-0">
                    <div className="font-display text-[14px] font-600 text-text-1 truncate">{project.name}</div>
                    {project.description && (
                      <p className="text-[12px] text-text-3/60 mt-0.5 line-clamp-2">{project.description}</p>
                    )}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); setEditingProjectId(project.id); setProjectSheetOpen(true) }}
                  className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md hover:bg-white/[0.08] transition-all text-text-3/50 hover:text-text-2"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  </svg>
                </button>
              </div>
              <div className="flex items-center gap-3 mt-2.5 text-[11px] text-text-3/50">
                <span>{counts.agents} agent{counts.agents !== 1 ? 's' : ''}</span>
                <span>{counts.tasks} task{counts.tasks !== 1 ? 's' : ''}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
