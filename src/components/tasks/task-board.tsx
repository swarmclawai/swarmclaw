'use client'

import { useEffect, useCallback, useState, useRef, useMemo } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import { updateTask, bulkUpdateTasks } from '@/lib/tasks'
import { TaskColumn } from './task-column'
import { Skeleton } from '@/components/shared/skeleton'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { BoardTaskStatus } from '@/types'
import { toast } from 'sonner'

const ACTIVE_COLUMNS: BoardTaskStatus[] = ['backlog', 'queued', 'running', 'completed', 'failed']

export function TaskBoard() {
  const tasks = useAppStore((s) => s.tasks)
  const loadTasks = useAppStore((s) => s.loadTasks)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)
  const setEditingTaskId = useAppStore((s) => s.setEditingTaskId)
  const agents = useAppStore((s) => s.agents)
  const projects = useAppStore((s) => s.projects)
  const loadProjects = useAppStore((s) => s.loadProjects)
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)
  const setActiveProjectFilter = useAppStore((s) => s.setActiveProjectFilter)
  const showArchived = useAppStore((s) => s.showArchivedTasks)
  const setShowArchived = useAppStore((s) => s.setShowArchivedTasks)

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const selectionMode = selectedIds.size > 0

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

  const selectAllInColumn = useCallback((status: BoardTaskStatus) => {
    const ids = Object.values(tasks)
      .filter((t) => t.status === status)
      .map((t) => t.id)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.add(id))
      return next
    })
  }, [tasks])

  // Bulk action handlers
  const [bulkActing, setBulkActing] = useState(false)
  const handleBulkStatus = useCallback(async (status: BoardTaskStatus) => {
    if (selectedIds.size === 0) return
    setBulkActing(true)
    try {
      await bulkUpdateTasks([...selectedIds], { status })
      await loadTasks()
      toast.success(`Moved ${selectedIds.size} task(s) to ${status}`)
      clearSelection()
    } catch {
      toast.error('Bulk update failed')
    } finally {
      setBulkActing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds])

  const handleBulkAgent = useCallback(async (agentId: string) => {
    if (selectedIds.size === 0) return
    setBulkActing(true)
    try {
      await bulkUpdateTasks([...selectedIds], { agentId })
      await loadTasks()
      const name = agents[agentId]?.name || 'agent'
      toast.success(`Assigned ${selectedIds.size} task(s) to ${name}`)
      clearSelection()
    } catch {
      toast.error('Bulk assign failed')
    } finally {
      setBulkActing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds, agents])

  const handleBulkProject = useCallback(async (projectId: string | null) => {
    if (selectedIds.size === 0) return
    setBulkActing(true)
    try {
      await bulkUpdateTasks([...selectedIds], { projectId })
      await loadTasks()
      toast.success(projectId ? `Assigned ${selectedIds.size} task(s) to project` : `Cleared project from ${selectedIds.size} task(s)`)
      clearSelection()
    } catch {
      toast.error('Bulk assign failed')
    } finally {
      setBulkActing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds])

  // Bulk action bar dropdowns
  const [bulkAgentOpen, setBulkAgentOpen] = useState(false)
  const [bulkProjectOpen, setBulkProjectOpen] = useState(false)
  const [bulkStatusOpen, setBulkStatusOpen] = useState(false)
  const bulkAgentRef = useRef<HTMLDivElement>(null)
  const bulkProjectRef = useRef<HTMLDivElement>(null)
  const bulkStatusRef = useRef<HTMLDivElement>(null)

  // URL-based filter state
  const [filterAgentId, setFilterAgentId] = useState<string>(() => {
    if (typeof window === 'undefined') return ''
    return new URLSearchParams(window.location.search).get('agent') || ''
  })
  const [filterTag, setFilterTag] = useState<string>(() => {
    if (typeof window === 'undefined') return ''
    return new URLSearchParams(window.location.search).get('tag') || ''
  })

  // Seed activeProjectFilter from URL on mount
  useEffect(() => {
    if (typeof window === 'undefined') return
    const urlProject = new URLSearchParams(window.location.search).get('project')
    if (urlProject && !activeProjectFilter) {
      setActiveProjectFilter(urlProject)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync filters to URL
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams()
    if (filterAgentId) params.set('agent', filterAgentId)
    if (filterTag) params.set('tag', filterTag)
    if (activeProjectFilter) params.set('project', activeProjectFilter)
    const qs = params.toString()
    const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}`
    window.history.replaceState(null, '', newUrl)
  }, [filterAgentId, filterTag, activeProjectFilter])

  const [loaded, setLoaded] = useState(Object.keys(tasks).length > 0)
  useEffect(() => { Promise.all([loadTasks(), loadAgents(), loadProjects()]).then(() => setLoaded(true)) }, [])
  useWs('tasks', loadTasks, 5000)

  // Collect all unique tags across tasks
  const allTags = Array.from(new Set(Object.values(tasks).flatMap((t) => t.tags || []))).sort()

  const columns: BoardTaskStatus[] = showArchived ? [...ACTIVE_COLUMNS, 'archived'] : ACTIVE_COLUMNS

  const tasksByStatus = useCallback((status: BoardTaskStatus) =>
    Object.values(tasks)
      .filter((t) => t.status === status
        && (!filterAgentId || t.agentId === filterAgentId)
        && (!filterTag || (t.tags && t.tags.includes(filterTag)))
        && (!activeProjectFilter || t.projectId === activeProjectFilter))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  [tasks, filterAgentId, filterTag, activeProjectFilter])

  const handleDrop = useCallback(async (taskId: string, newStatus: BoardTaskStatus) => {
    const task = tasks[taskId]
    if (!task || task.status === newStatus) return
    await updateTask(taskId, { status: newStatus })
    await loadTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks])

  const archivedCount = Object.values(tasks).filter((t) => t.status === 'archived').length

  // Task counts per project (non-archived)
  const projectTaskCounts: Record<string, number> = {}
  for (const t of Object.values(tasks)) {
    if (t.projectId && t.status !== 'archived') {
      projectTaskCounts[t.projectId] = (projectTaskCounts[t.projectId] || 0) + 1
    }
  }

  // Summary stats
  const stats = useMemo(() => {
    const all = Object.values(tasks).filter((t) => t.status !== 'archived')
    return {
      total: all.length,
      running: all.filter((t) => t.status === 'running').length,
      completed: all.filter((t) => t.status === 'completed').length,
      failed: all.filter((t) => t.status === 'failed').length,
      overdue: all.filter((t) => t.dueAt && t.dueAt < Date.now() && t.status !== 'completed').length,
    }
  }, [tasks])

  // Custom dropdown state
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false)
  const projectDropdownRef = useRef<HTMLDivElement>(null)
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false)
  const agentDropdownRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!projectDropdownOpen && !agentDropdownOpen && !bulkAgentOpen && !bulkProjectOpen && !bulkStatusOpen) return
    const onClickOutside = (e: MouseEvent) => {
      if (projectDropdownOpen && projectDropdownRef.current && !projectDropdownRef.current.contains(e.target as Node)) {
        setProjectDropdownOpen(false)
      }
      if (agentDropdownOpen && agentDropdownRef.current && !agentDropdownRef.current.contains(e.target as Node)) {
        setAgentDropdownOpen(false)
      }
      if (bulkAgentOpen && bulkAgentRef.current && !bulkAgentRef.current.contains(e.target as Node)) {
        setBulkAgentOpen(false)
      }
      if (bulkProjectOpen && bulkProjectRef.current && !bulkProjectRef.current.contains(e.target as Node)) {
        setBulkProjectOpen(false)
      }
      if (bulkStatusOpen && bulkStatusRef.current && !bulkStatusRef.current.contains(e.target as Node)) {
        setBulkStatusOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [projectDropdownOpen, agentDropdownOpen, bulkAgentOpen, bulkProjectOpen, bulkStatusOpen])

  // Escape key to clear selection
  useEffect(() => {
    if (!selectionMode) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearSelection()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionMode])

  return (
    <div className="flex-1 min-h-0 flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-8 pt-6 pb-4 shrink-0">
        <div>
          <h1 className="font-display text-[28px] font-800 tracking-[-0.03em]">Task Board</h1>
          <div className="flex items-center gap-3 mt-1">
            <p className="text-[13px] text-text-3">
              {stats.total} task{stats.total !== 1 ? 's' : ''}
            </p>
            {stats.running > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] font-600 text-blue-400">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                {stats.running} running
              </span>
            )}
            {stats.overdue > 0 && (
              <span className="text-[11px] font-600 text-red-400">
                {stats.overdue} overdue
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative" ref={agentDropdownRef}>
            <button
              onClick={() => setAgentDropdownOpen(!agentDropdownOpen)}
              className={`flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
                ${filterAgentId
                  ? 'bg-white/[0.06] border-white/[0.1] text-text-2'
                  : 'bg-transparent border-white/[0.06] text-text-3 hover:bg-white/[0.03]'}`}
              style={{ fontFamily: 'inherit', minWidth: 130 }}
            >
              {filterAgentId && agents[filterAgentId] ? (
                <>
                  <AgentAvatar seed={agents[filterAgentId].avatarSeed || null} avatarUrl={agents[filterAgentId].avatarUrl} name={agents[filterAgentId].name} size={18} />
                  {agents[filterAgentId].name}
                </>
              ) : 'All Agents'}
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="ml-auto opacity-50">
                <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {agentDropdownOpen && (
              <div className="absolute top-full right-0 mt-1 min-w-[200px] py-1 rounded-[12px] border border-white/[0.08] bg-surface-2 shadow-lg z-50">
                <button
                  onClick={() => { setFilterAgentId(''); setAgentDropdownOpen(false) }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-[13px] font-600 cursor-pointer border-none text-left transition-colors
                    ${!filterAgentId ? 'bg-white/[0.06] text-text' : 'bg-transparent text-text-3 hover:bg-white/[0.04]'}`}
                  style={{ fontFamily: 'inherit' }}
                >
                  All Agents
                </button>
                {Object.values(agents).sort((a, b) => a.name.localeCompare(b.name)).map((a) => (
                  <button
                    key={a.id}
                    onClick={() => { setFilterAgentId(a.id); setAgentDropdownOpen(false) }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-[13px] font-600 cursor-pointer border-none text-left transition-colors
                      ${filterAgentId === a.id ? 'bg-white/[0.06] text-text' : 'bg-transparent text-text-3 hover:bg-white/[0.04]'}`}
                    style={{ fontFamily: 'inherit' }}
                  >
                    <AgentAvatar seed={a.avatarSeed || null} avatarUrl={a.avatarUrl} name={a.name} size={20} />
                    {a.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          {Object.keys(projects).length > 0 && (
            <div className="relative" ref={projectDropdownRef}>
              <button
                onClick={() => setProjectDropdownOpen(!projectDropdownOpen)}
                className={`flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
                  ${activeProjectFilter
                    ? 'bg-white/[0.06] border-white/[0.1] text-text-2'
                    : 'bg-transparent border-white/[0.06] text-text-3 hover:bg-white/[0.03]'}`}
                style={{ fontFamily: 'inherit', minWidth: 130 }}
              >
                {activeProjectFilter && projects[activeProjectFilter] ? (
                  <>
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: projects[activeProjectFilter].color || '#6366F1' }} />
                    {projects[activeProjectFilter].name}
                  </>
                ) : 'All Projects'}
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="ml-auto opacity-50">
                  <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {projectDropdownOpen && (
                <div className="absolute top-full right-0 mt-1 min-w-[180px] py-1 rounded-[12px] border border-white/[0.08] bg-surface-2 shadow-lg z-50">
                  <button
                    onClick={() => { setActiveProjectFilter(null); setProjectDropdownOpen(false) }}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-[13px] font-600 cursor-pointer border-none text-left transition-colors
                      ${!activeProjectFilter ? 'bg-white/[0.06] text-text' : 'bg-transparent text-text-3 hover:bg-white/[0.04]'}`}
                    style={{ fontFamily: 'inherit' }}
                  >
                    All Projects
                  </button>
                  {Object.values(projects).map((p) => (
                    <button
                      key={p.id}
                      onClick={() => { setActiveProjectFilter(p.id); setProjectDropdownOpen(false) }}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-[13px] font-600 cursor-pointer border-none text-left transition-colors
                        ${activeProjectFilter === p.id ? 'bg-white/[0.06] text-text' : 'bg-transparent text-text-3 hover:bg-white/[0.04]'}`}
                      style={{ fontFamily: 'inherit' }}
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color || '#6366F1' }} />
                      {p.name}
                      {(projectTaskCounts[p.id] ?? 0) > 0 && (
                        <span className="ml-auto text-[11px] text-text-3/60">{projectTaskCounts[p.id]}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {allTags.length > 0 && (
            <select
              value={filterTag}
              onChange={(e) => setFilterTag(e.target.value)}
              className="px-3 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
                bg-transparent border-white/[0.06] text-text-3 hover:bg-white/[0.03] appearance-none"
              style={{ fontFamily: 'inherit', minWidth: 110 }}
            >
              <option value="">All Tags</option>
              {allTags.map((tag) => (
                <option key={tag} value={tag}>{tag}</option>
              ))}
            </select>
          )}
          <button
            onClick={() => setShowArchived(!showArchived)}
            className={`px-4 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
              ${showArchived
                ? 'bg-white/[0.06] border-white/[0.1] text-text-2'
                : 'bg-transparent border-white/[0.06] text-text-3 hover:bg-white/[0.03]'}`}
            style={{ fontFamily: 'inherit' }}
          >
            {showArchived ? 'Hide' : 'Show'} Archived{!showArchived && archivedCount > 0 ? ` (${archivedCount})` : ''}
          </button>
          <button
            onClick={() => {
              setEditingTaskId(null)
              setTaskSheetOpen(true)
            }}
            className="px-5 py-2.5 rounded-[12px] border-none bg-accent-bright text-white text-[14px] font-600 cursor-pointer
              hover:brightness-110 active:scale-[0.97] transition-all shadow-[0_2px_12px_rgba(99,102,241,0.2)]"
            style={{ fontFamily: 'inherit' }}
          >
            + New Task
          </button>
        </div>
      </div>

      {activeProjectFilter && projects[activeProjectFilter] && (
        <div className="flex items-center gap-2 px-8 pb-3">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-white/[0.04] border border-white/[0.06] text-[12px] font-600 text-text-2">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: projects[activeProjectFilter].color || '#6366F1' }} />
            {projects[activeProjectFilter].name}
            <button
              onClick={() => setActiveProjectFilter(null)}
              className="ml-1 text-text-3 hover:text-text cursor-pointer border-none bg-transparent p-0 text-[14px] leading-none"
            >
              &times;
            </button>
          </span>
        </div>
      )}

      <div className="flex-1 min-h-0 flex gap-5 px-8 pb-6 overflow-x-auto overflow-y-hidden overscroll-x-contain touch-pan-x">
        {!loaded ? (
          ACTIVE_COLUMNS.map((status) => (
            <div key={status} className="flex flex-col gap-3 min-w-[260px] flex-1">
              <Skeleton className="rounded-[10px]" width="100%" height={32} />
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="rounded-[12px]" width="100%" height={80} />
              ))}
            </div>
          ))
        ) : (
          columns.map((status, idx) => (
            <div
              key={status}
              className="flex flex-col gap-3 min-w-[260px] flex-1"
              style={{
                animation: 'fade-up 0.6s var(--ease-spring) both',
                animationDelay: `${idx * 0.1}s`
              }}
            >
              <TaskColumn
                status={status}
                tasks={tasksByStatus(status)}
                onDrop={handleDrop}
                selectionMode={selectionMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onSelectAll={() => selectAllInColumn(status)}
              />
            </div>
          ))
        )}
      </div>

      {/* Bulk action bar */}
      {selectionMode && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-3 rounded-[16px] bg-surface-2/95 backdrop-blur-xl border border-white/[0.1] shadow-[0_8px_40px_rgba(0,0,0,0.5)] z-50">
          <span className="text-[13px] font-600 text-text mr-2">
            {selectedIds.size} selected
          </span>
          <div className="w-px h-5 bg-white/[0.08]" />

          {/* Move to status */}
          <div className="relative" ref={bulkStatusRef}>
            <button
              onClick={() => { setBulkStatusOpen(!bulkStatusOpen); setBulkAgentOpen(false); setBulkProjectOpen(false) }}
              disabled={bulkActing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12px] font-600 text-text-2 bg-white/[0.06] border-none cursor-pointer hover:bg-white/[0.1] transition-colors disabled:opacity-50"
              style={{ fontFamily: 'inherit' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
              Move
            </button>
            {bulkStatusOpen && (
              <div className="absolute bottom-full left-0 mb-1 min-w-[140px] py-1 rounded-[10px] border border-white/[0.08] bg-surface-2 shadow-lg">
                {ACTIVE_COLUMNS.map((s) => (
                  <button
                    key={s}
                    onClick={() => { handleBulkStatus(s); setBulkStatusOpen(false) }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-[12px] font-600 cursor-pointer border-none text-left bg-transparent text-text-3 hover:bg-white/[0.06] hover:text-text transition-colors"
                    style={{ fontFamily: 'inherit' }}
                  >
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Assign agent */}
          <div className="relative" ref={bulkAgentRef}>
            <button
              onClick={() => { setBulkAgentOpen(!bulkAgentOpen); setBulkStatusOpen(false); setBulkProjectOpen(false) }}
              disabled={bulkActing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12px] font-600 text-text-2 bg-white/[0.06] border-none cursor-pointer hover:bg-white/[0.1] transition-colors disabled:opacity-50"
              style={{ fontFamily: 'inherit' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /></svg>
              Agent
            </button>
            {bulkAgentOpen && (
              <div className="absolute bottom-full left-0 mb-1 min-w-[180px] max-h-[200px] overflow-y-auto py-1 rounded-[10px] border border-white/[0.08] bg-surface-2 shadow-lg">
                {Object.values(agents).sort((a, b) => a.name.localeCompare(b.name)).map((a) => (
                  <button
                    key={a.id}
                    onClick={() => { handleBulkAgent(a.id); setBulkAgentOpen(false) }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-[12px] font-600 cursor-pointer border-none text-left bg-transparent text-text-3 hover:bg-white/[0.06] hover:text-text transition-colors"
                    style={{ fontFamily: 'inherit' }}
                  >
                    <AgentAvatar seed={a.avatarSeed || null} avatarUrl={a.avatarUrl} name={a.name} size={16} />
                    {a.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Assign project */}
          {Object.keys(projects).length > 0 && (
            <div className="relative" ref={bulkProjectRef}>
              <button
                onClick={() => { setBulkProjectOpen(!bulkProjectOpen); setBulkStatusOpen(false); setBulkAgentOpen(false) }}
                disabled={bulkActing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12px] font-600 text-text-2 bg-white/[0.06] border-none cursor-pointer hover:bg-white/[0.1] transition-colors disabled:opacity-50"
                style={{ fontFamily: 'inherit' }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7-7H4a2 2 0 0 0-2 2v17Z" /><path d="M14 2v7h7" /></svg>
                Project
              </button>
              {bulkProjectOpen && (
                <div className="absolute bottom-full left-0 mb-1 min-w-[160px] max-h-[200px] overflow-y-auto py-1 rounded-[10px] border border-white/[0.08] bg-surface-2 shadow-lg">
                  <button
                    onClick={() => { handleBulkProject(null); setBulkProjectOpen(false) }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-[12px] font-600 cursor-pointer border-none text-left bg-transparent text-text-3 hover:bg-white/[0.06] hover:text-text transition-colors"
                    style={{ fontFamily: 'inherit' }}
                  >
                    No project
                  </button>
                  {Object.values(projects).map((p) => (
                    <button
                      key={p.id}
                      onClick={() => { handleBulkProject(p.id); setBulkProjectOpen(false) }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-[12px] font-600 cursor-pointer border-none text-left bg-transparent text-text-3 hover:bg-white/[0.06] hover:text-text transition-colors"
                      style={{ fontFamily: 'inherit' }}
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: p.color || '#6366F1' }} />
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="w-px h-5 bg-white/[0.08]" />

          {/* Archive selected */}
          <button
            onClick={() => handleBulkStatus('archived')}
            disabled={bulkActing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12px] font-600 text-amber-400 bg-amber-500/10 border-none cursor-pointer hover:bg-amber-500/20 transition-colors disabled:opacity-50"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 8v13H3V8" /><path d="M1 3h22v5H1z" /><path d="M10 12h4" /></svg>
            Archive
          </button>

          {/* Clear selection */}
          <button
            onClick={clearSelection}
            className="p-1.5 rounded-[8px] text-text-3 hover:text-text hover:bg-white/[0.06] border-none bg-transparent cursor-pointer transition-colors"
            title="Clear selection (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      )}
    </div>
  )
}
