'use client'

import { useEffect, useCallback, useState, useRef, useMemo } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import { updateTask, bulkUpdateTasks, importGitHubIssues, type GitHubIssueImportResult } from '@/lib/tasks'
import { TaskColumn } from './task-column'
import { TaskCard } from './task-card'
import { Skeleton } from '@/components/shared/skeleton'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import { inputClass } from '@/components/shared/form-styles'
import { useNow } from '@/hooks/use-now'
import type { BoardTask, BoardTaskStatus } from '@/types'
import { toast } from 'sonner'

const ACTIVE_COLUMNS: BoardTaskStatus[] = ['backlog', 'queued', 'running', 'completed', 'failed']
type BoardViewMode = 'board' | 'list'
type AttentionFilter = 'all' | 'needs-attention' | 'approval' | 'blocked' | 'overdue' | 'failed'
type TaskScopeFilter = 'user-facing' | 'all' | 'agent'

function isTaskOverdue(task: BoardTask, now: number | null): boolean {
  return !!now && !!task.dueAt && task.dueAt < now && task.status !== 'completed' && task.status !== 'archived'
}

function isInternalAgentTask(task: BoardTask): boolean {
  if (task.sourceType === 'schedule' || task.sourceType === 'delegation') return true
  return Boolean(task.createdByAgentId || task.delegatedByAgentId)
}

function isTaskRelevantToAgent(task: BoardTask, agentId: string): boolean {
  return task.agentId === agentId
    || task.createdByAgentId === agentId
    || task.delegatedByAgentId === agentId
}

function matchesAttentionFilter(task: BoardTask, filter: AttentionFilter, now: number | null): boolean {
  const blocked = !!task.blockedBy?.length
  const pendingApproval = !!task.pendingApproval
  const overdue = isTaskOverdue(task, now)
  const failed = task.status === 'failed'
  if (filter === 'all') return true
  if (filter === 'approval') return pendingApproval
  if (filter === 'blocked') return blocked
  if (filter === 'overdue') return overdue
  if (filter === 'failed') return failed
  return blocked || pendingApproval || overdue || failed
}

function attentionRank(task: BoardTask, now: number | null): number {
  if (task.pendingApproval) return 0
  if (task.status === 'failed') return 1
  if (task.blockedBy?.length) return 2
  if (isTaskOverdue(task, now)) return 3
  if (task.status === 'running') return 4
  if (task.status === 'queued') return 5
  return 6
}

export function TaskBoard() {
  const now = useNow()
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
  const [filterAgentId, setFilterAgentId] = useState<string>('')
  const [filterTag, setFilterTag] = useState<string>('')
  const [taskScopeFilter, setTaskScopeFilter] = useState<TaskScopeFilter>('user-facing')
  const [filtersHydrated, setFiltersHydrated] = useState(false)
  const [viewMode, setViewMode] = useState<BoardViewMode>('board')
  const [attentionFilter, setAttentionFilter] = useState<AttentionFilter>('all')
  const [githubImportOpen, setGitHubImportOpen] = useState(false)
  const [githubRepo, setGitHubRepo] = useState('')
  const [githubToken, setGitHubToken] = useState('')
  const [githubState, setGitHubState] = useState<'open' | 'closed' | 'all'>('open')
  const [githubLimit, setGitHubLimit] = useState('25')
  const [githubLabels, setGitHubLabels] = useState('')
  const [githubImporting, setGitHubImporting] = useState(false)
  const [githubImportError, setGitHubImportError] = useState<string | null>(null)
  const [githubImportResult, setGitHubImportResult] = useState<GitHubIssueImportResult | null>(null)

  // Seed URL-backed filters after hydration so the initial tree stays deterministic.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const urlAgent = params.get('agent') || ''
    const urlTag = params.get('tag') || ''
    const urlProject = params.get('project')
    const rawTaskView = params.get('taskView')

    setFilterAgentId(urlAgent)
    setFilterTag(urlTag)
    setTaskScopeFilter(urlAgent ? 'agent' : rawTaskView === 'all' ? 'all' : 'user-facing')
    if (urlProject && !activeProjectFilter) setActiveProjectFilter(urlProject)
    setFiltersHydrated(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync filters to URL
  useEffect(() => {
    if (!filtersHydrated) return
    const params = new URLSearchParams()
    if (taskScopeFilter === 'agent' && filterAgentId) params.set('agent', filterAgentId)
    else if (taskScopeFilter === 'all') params.set('taskView', 'all')
    if (filterTag) params.set('tag', filterTag)
    if (activeProjectFilter) params.set('project', activeProjectFilter)
    const qs = params.toString()
    const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}`
    window.history.replaceState(null, '', newUrl)
  }, [activeProjectFilter, filterAgentId, filterTag, filtersHydrated, taskScopeFilter])

  const [loaded, setLoaded] = useState(Object.keys(tasks).length > 0)
  useEffect(() => {
    Promise.all([loadTasks(), loadAgents(), loadProjects()]).then(() => setLoaded(true))
  }, [loadAgents, loadProjects, loadTasks])
  useWs('tasks', loadTasks, 5000)

  // Collect all unique tags across tasks
  const allTags = Array.from(new Set(Object.values(tasks).flatMap((t) => t.tags || []))).sort()

  const columns: BoardTaskStatus[] = showArchived ? [...ACTIVE_COLUMNS, 'archived'] : ACTIVE_COLUMNS

  const matchesScopeFilters = useCallback((task: BoardTask) => {
    if (!showArchived && task.status === 'archived') return false
    if (taskScopeFilter === 'user-facing' && isInternalAgentTask(task)) return false
    if (taskScopeFilter === 'agent' && (!filterAgentId || !isTaskRelevantToAgent(task, filterAgentId))) return false
    if (filterTag && !(task.tags && task.tags.includes(filterTag))) return false
    if (activeProjectFilter && task.projectId !== activeProjectFilter) return false
    return true
  }, [activeProjectFilter, filterAgentId, filterTag, showArchived, taskScopeFilter])

  const matchesBaseFilters = useCallback((task: BoardTask) => {
    if (!matchesScopeFilters(task)) return false
    if (!matchesAttentionFilter(task, attentionFilter, now)) return false
    return true
  }, [attentionFilter, matchesScopeFilters, now])

  const scopedTasks = useMemo(
    () => Object.values(tasks).filter(matchesScopeFilters),
    [tasks, matchesScopeFilters],
  )

  const filteredTasks = useMemo(() => (
    scopedTasks
      .filter(matchesBaseFilters)
      .sort((a, b) => {
        const rankDiff = attentionRank(a, now) - attentionRank(b, now)
        if (rankDiff !== 0) return rankDiff
        const dueDiff = (a.dueAt || Number.MAX_SAFE_INTEGER) - (b.dueAt || Number.MAX_SAFE_INTEGER)
        if (dueDiff !== 0) return dueDiff
        return b.updatedAt - a.updatedAt
      })
  ), [scopedTasks, matchesBaseFilters, now])

  const tasksByStatus = useCallback((status: BoardTaskStatus) =>
    filteredTasks
      .filter((t) => t.status === status)
      .sort((a, b) => b.updatedAt - a.updatedAt),
  [filteredTasks])

  const selectAllInColumn = useCallback((status: BoardTaskStatus) => {
    const ids = filteredTasks
      .filter((t) => t.status === status)
      .map((t) => t.id)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      ids.forEach((id) => next.add(id))
      return next
    })
  }, [filteredTasks])

  const handleDrop = useCallback(async (taskId: string, newStatus: BoardTaskStatus) => {
    const task = tasks[taskId]
    if (!task || task.status === newStatus) return
    await updateTask(taskId, { status: newStatus })
    await loadTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks])

  const archivedCount = Object.values(tasks).filter((t) => t.status === 'archived').length

  const resetGitHubImportState = useCallback(() => {
    setGitHubImportError(null)
    setGitHubImportResult(null)
  }, [])

  const handleGitHubImport = useCallback(async () => {
    if (!githubRepo.trim()) {
      setGitHubImportError('Repository is required.')
      return
    }

    setGitHubImporting(true)
    setGitHubImportError(null)
    setGitHubImportResult(null)

    try {
      const rawLimit = Number.parseInt(githubLimit, 10)
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 200)) : 25
      const result = await importGitHubIssues({
        repo: githubRepo.trim(),
        token: githubToken.trim() || undefined,
        state: githubState,
        limit,
        labels: githubLabels
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        projectId: activeProjectFilter,
      })
      setGitHubImportResult(result)
      await loadTasks()
      const summary = result.created.length > 0
        ? `Imported ${result.created.length} issue(s) from ${result.repo}`
        : `No new issues imported from ${result.repo}`
      const suffix = result.skipped.length > 0 ? `, skipped ${result.skipped.length} existing` : ''
      toast.success(summary + suffix)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'GitHub import failed'
      setGitHubImportError(message)
      toast.error(message)
    } finally {
      setGitHubImporting(false)
    }
  }, [
    activeProjectFilter,
    githubLabels,
    githubLimit,
    githubRepo,
    githubState,
    githubToken,
    loadTasks,
  ])

  // Task counts per project (non-archived)
  const projectTaskCounts: Record<string, number> = {}
  for (const t of scopedTasks) {
    if (t.projectId && t.status !== 'archived') {
      projectTaskCounts[t.projectId] = (projectTaskCounts[t.projectId] || 0) + 1
    }
  }

  // Summary stats
  const stats = useMemo(() => {
    const all = scopedTasks.filter((t) => t.status !== 'archived')
    return {
      total: all.length,
      running: all.filter((t) => t.status === 'running').length,
      completed: all.filter((t) => t.status === 'completed').length,
      failed: all.filter((t) => t.status === 'failed').length,
      overdue: all.filter((t) => isTaskOverdue(t, now)).length,
      blocked: all.filter((t) => (t.blockedBy?.length || 0) > 0).length,
      approvals: all.filter((t) => !!t.pendingApproval).length,
      attention: all.filter((t) => matchesAttentionFilter(t, 'needs-attention', now)).length,
    }
  }, [now, scopedTasks])

  const activeScopeLabel = useMemo(() => {
    if (taskScopeFilter === 'all') return 'All tasks'
    if (taskScopeFilter === 'agent' && filterAgentId && agents[filterAgentId]) return `${agents[filterAgentId].name} activity`
    return 'User-facing tasks'
  }, [agents, filterAgentId, taskScopeFilter])

  const activeAttentionLabel = useMemo(() => {
    if (attentionFilter === 'all') return null
    if (attentionFilter === 'needs-attention') return 'Needs attention'
    if (attentionFilter === 'approval') return 'Awaiting approval'
    if (attentionFilter === 'blocked') return 'Blocked tasks'
    if (attentionFilter === 'overdue') return 'Overdue tasks'
    return 'Failed tasks'
  }, [attentionFilter])

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
            <span className="inline-flex items-center gap-1 rounded-full bg-white/[0.04] px-2 py-1 text-[11px] font-600 text-text-2">
              {taskScopeFilter === 'agent' && filterAgentId && agents[filterAgentId] ? (
                <>
                  <AgentAvatar seed={agents[filterAgentId].avatarSeed || null} avatarUrl={agents[filterAgentId].avatarUrl} name={agents[filterAgentId].name} size={14} />
                  {activeScopeLabel}
                </>
              ) : (
                activeScopeLabel
              )}
            </span>
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
          <div className="flex items-center gap-1 p-1 rounded-[11px] bg-surface-2 border border-white/[0.06]">
            {([
              ['board', 'Board'],
              ['list', 'List'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setViewMode(value)}
                className={`px-3 py-1.5 rounded-[8px] text-[12px] font-700 transition-all cursor-pointer border-none ${
                  viewMode === value
                    ? 'bg-accent-soft text-accent-bright'
                    : 'text-text-3 hover:text-text-2'
                }`}
                style={{ fontFamily: 'inherit' }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="relative" ref={agentDropdownRef}>
            <button
              onClick={() => setAgentDropdownOpen(!agentDropdownOpen)}
              className={`flex items-center gap-2 px-3 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border
                ${taskScopeFilter !== 'user-facing'
                  ? 'bg-white/[0.06] border-white/[0.1] text-text-2'
                  : 'bg-transparent border-white/[0.06] text-text-3 hover:bg-white/[0.03]'}`}
              style={{ fontFamily: 'inherit', minWidth: 130 }}
            >
              {taskScopeFilter === 'agent' && filterAgentId && agents[filterAgentId] ? (
                <>
                  <AgentAvatar seed={agents[filterAgentId].avatarSeed || null} avatarUrl={agents[filterAgentId].avatarUrl} name={agents[filterAgentId].name} size={18} />
                  {agents[filterAgentId].name}
                </>
              ) : taskScopeFilter === 'all' ? 'All Tasks' : 'User View'}
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="ml-auto opacity-50">
                <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {agentDropdownOpen && (
              <div className="absolute top-full right-0 mt-1 min-w-[240px] py-1 rounded-[12px] border border-white/[0.08] bg-surface-2 shadow-lg z-50">
                <button
                  onClick={() => {
                    setTaskScopeFilter('user-facing')
                    setFilterAgentId('')
                    setAgentDropdownOpen(false)
                  }}
                  className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-[13px] font-600 cursor-pointer border-none text-left transition-colors
                    ${taskScopeFilter === 'user-facing' ? 'bg-white/[0.06] text-text' : 'bg-transparent text-text-3 hover:bg-white/[0.04]'}`}
                  style={{ fontFamily: 'inherit' }}
                >
                  <span className="mt-0.5 inline-flex h-5 items-center rounded-full bg-emerald-500/12 px-1.5 text-[10px] font-700 uppercase tracking-[0.08em] text-emerald-400">
                    Default
                  </span>
                  <span className="min-w-0">
                    <span className="block">User-facing tasks</span>
                    <span className="mt-0.5 block text-[11px] font-500 text-text-3/60">
                      Hide scheduled, delegated, and agent-created internal work.
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => {
                    setTaskScopeFilter('all')
                    setFilterAgentId('')
                    setAgentDropdownOpen(false)
                  }}
                  className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-[13px] font-600 cursor-pointer border-none text-left transition-colors
                    ${taskScopeFilter === 'all' ? 'bg-white/[0.06] text-text' : 'bg-transparent text-text-3 hover:bg-white/[0.04]'}`}
                  style={{ fontFamily: 'inherit' }}
                >
                  <span className="mt-0.5 inline-flex h-5 items-center rounded-full bg-white/[0.06] px-1.5 text-[10px] font-700 uppercase tracking-[0.08em] text-text-3">
                    All
                  </span>
                  <span className="min-w-0">
                    <span className="block">All tasks</span>
                    <span className="mt-0.5 block text-[11px] font-500 text-text-3/60">
                      Include internal agent execution, schedules, and delegations.
                    </span>
                  </span>
                </button>
                <div className="my-1 border-t border-white/[0.06]" />
                {Object.values(agents).sort((a, b) => a.name.localeCompare(b.name)).map((a) => (
                  <button
                    key={a.id}
                    onClick={() => {
                      setTaskScopeFilter('agent')
                      setFilterAgentId(a.id)
                      setAgentDropdownOpen(false)
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-[13px] font-600 cursor-pointer border-none text-left transition-colors
                      ${taskScopeFilter === 'agent' && filterAgentId === a.id ? 'bg-white/[0.06] text-text' : 'bg-transparent text-text-3 hover:bg-white/[0.04]'}`}
                    style={{ fontFamily: 'inherit' }}
                  >
                    <AgentAvatar seed={a.avatarSeed || null} avatarUrl={a.avatarUrl} name={a.name} size={20} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{a.name}</span>
                      <span className="mt-0.5 block text-[11px] font-500 text-text-3/60">
                        Assigned, created, or delegated by this agent
                      </span>
                    </span>
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
              resetGitHubImportState()
              setGitHubImportOpen(true)
            }}
            className="px-4 py-2 rounded-[10px] text-[13px] font-600 cursor-pointer transition-all border border-white/[0.08] bg-white/[0.04] text-text-2 hover:bg-white/[0.08]"
            style={{ fontFamily: 'inherit' }}
          >
            Import GitHub
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

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 px-8 pb-4">
        {[
          { key: 'needs-attention', label: 'Needs Attention', value: stats.attention, tone: 'text-red-300', accent: 'bg-red-500/10' },
          { key: 'approval', label: 'Approvals', value: stats.approvals, tone: 'text-amber-400', accent: 'bg-amber-500/10' },
          { key: 'blocked', label: 'Blocked', value: stats.blocked, tone: 'text-rose-400', accent: 'bg-rose-500/10' },
          { key: 'overdue', label: 'Overdue', value: stats.overdue, tone: 'text-red-400', accent: 'bg-red-500/10' },
          { key: 'failed', label: 'Failed', value: stats.failed, tone: 'text-orange-400', accent: 'bg-orange-500/10' },
        ].map((item) => (
          <button
            key={item.key}
            onClick={() => setAttentionFilter((current) => (current === item.key ? 'all' : item.key as AttentionFilter))}
            className={`rounded-[14px] border px-4 py-3 text-left transition-all cursor-pointer ${
              attentionFilter === item.key
                ? 'border-white/[0.12] bg-white/[0.05]'
                : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]'
            }`}
            style={{ fontFamily: 'inherit' }}
          >
            <div className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-700 uppercase tracking-[0.08em] ${item.accent} ${item.tone}`}>
              {item.label}
            </div>
            <div className={`mt-3 text-[24px] font-display font-700 tracking-[-0.03em] ${item.tone}`}>
              {item.value}
            </div>
            <p className="mt-1 text-[11px] text-text-3/60">
              {item.value === 0 ? 'Nothing waiting here' : 'Click to focus this queue'}
            </p>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-8 pb-3">
        {([
          ['all', 'All'],
          ['needs-attention', 'Needs Attention'],
          ['approval', 'Awaiting Approval'],
          ['blocked', 'Blocked'],
          ['overdue', 'Overdue'],
          ['failed', 'Failed'],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setAttentionFilter(value)}
            className={`px-3 py-1.5 rounded-[8px] text-[11px] font-600 transition-all cursor-pointer border-none ${
              attentionFilter === value
                ? 'bg-accent-soft text-accent-bright'
                : 'bg-white/[0.04] text-text-3 hover:bg-white/[0.08] hover:text-text-2'
            }`}
            style={{ fontFamily: 'inherit' }}
          >
            {label}
          </button>
        ))}
      </div>

      {(activeProjectFilter && projects[activeProjectFilter]) || activeAttentionLabel || taskScopeFilter !== 'all' ? (
        <div className="flex flex-wrap items-center gap-2 px-8 pb-3">
          {taskScopeFilter !== 'all' && (
            <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] border text-[12px] font-600 ${
              taskScopeFilter === 'agent'
                ? 'bg-accent-soft border-accent-bright/20 text-accent-bright'
                : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
            }`}>
              {taskScopeFilter === 'agent' && filterAgentId && agents[filterAgentId] ? (
                <>
                  <AgentAvatar seed={agents[filterAgentId].avatarSeed || null} avatarUrl={agents[filterAgentId].avatarUrl} name={agents[filterAgentId].name} size={14} />
                  {agents[filterAgentId].name} activity
                </>
              ) : (
                'User-facing tasks'
              )}
              <button
                onClick={() => {
                  setTaskScopeFilter('all')
                  setFilterAgentId('')
                }}
                className="ml-1 cursor-pointer border-none bg-transparent p-0 text-[14px] leading-none text-current opacity-80 hover:opacity-100"
              >
                &times;
              </button>
            </span>
          )}
          {activeProjectFilter && projects[activeProjectFilter] && (
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
          )}
          {activeAttentionLabel && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-amber-500/10 border border-amber-500/20 text-[12px] font-600 text-amber-400">
              {activeAttentionLabel}
              <button
                onClick={() => setAttentionFilter('all')}
                className="ml-1 text-amber-300 hover:text-white cursor-pointer border-none bg-transparent p-0 text-[14px] leading-none"
              >
                &times;
              </button>
            </span>
          )}
        </div>
      ) : null}

      {viewMode === 'board' ? (
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
      ) : (
        <div className="flex-1 overflow-y-auto px-8 pb-6">
          {!loaded ? (
            <div className="max-w-4xl mx-auto flex flex-col gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="rounded-[14px]" width="100%" height={112} />
              ))}
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="max-w-3xl mx-auto rounded-[16px] border border-dashed border-white/[0.08] px-6 py-14 text-center">
              <p className="text-[14px] font-600 text-text-2 mb-1">No tasks match this view</p>
              <p className="text-[12px] text-text-3/60">Try clearing one of the active filters or switching back to all tasks.</p>
            </div>
          ) : (
            <div className="max-w-4xl mx-auto">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="font-display text-[18px] font-700 tracking-[-0.02em] text-text">
                    {attentionFilter === 'all' ? 'Task List' : activeAttentionLabel || 'Task List'}
                  </h2>
                  <p className="text-[12px] text-text-3/60">
                    {attentionFilter === 'all'
                      ? 'All visible tasks, sorted by urgency and freshness.'
                      : 'Sorted by approval, failures, blockers, and due dates.'}
                  </p>
                </div>
                <div className="text-[12px] text-text-3/60">
                  {filteredTasks.length} visible task{filteredTasks.length !== 1 ? 's' : ''}
                </div>
              </div>
              <div className="flex flex-col gap-3">
                {filteredTasks.map((task, idx) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    index={idx}
                    selectionMode={selectionMode}
                    selected={selectedIds.has(task.id)}
                    onToggleSelect={toggleSelect}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <BottomSheet
        open={githubImportOpen}
        onClose={() => {
          setGitHubImportOpen(false)
          setGitHubImportError(null)
        }}
        wide
        title="Import GitHub Issues"
        description="Pull issues from a GitHub repository into the task board as backlog items."
      >
        <div className="mx-auto w-full max-w-2xl">
          <div className="mb-6">
            <h2 className="font-display text-[24px] font-800 tracking-[-0.03em] text-text">Import GitHub Issues</h2>
            <p className="mt-2 text-[14px] text-text-3">
              Pull issues from a GitHub repository into the task board as backlog items.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
            <label className="block">
              <span className="mb-2 block text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/70">Repository</span>
              <input
                value={githubRepo}
                onChange={(e) => setGitHubRepo(e.target.value)}
                placeholder="owner/repo or https://github.com/owner/repo"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/70">State</span>
              <select
                value={githubState}
                onChange={(e) => setGitHubState(e.target.value as 'open' | 'closed' | 'all')}
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              >
                <option value="open">Open issues</option>
                <option value="closed">Closed issues</option>
                <option value="all">All issues</option>
              </select>
            </label>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/70">Limit</span>
              <input
                type="number"
                min={1}
                max={200}
                value={githubLimit}
                onChange={(e) => setGitHubLimit(e.target.value)}
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/70">Labels</span>
              <input
                value={githubLabels}
                onChange={(e) => setGitHubLabels(e.target.value)}
                placeholder="bug, api, high priority"
                className={inputClass}
                style={{ fontFamily: 'inherit' }}
              />
            </label>
          </div>

          <label className="mt-4 block">
            <span className="mb-2 block text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/70">GitHub token</span>
            <input
              type="password"
              value={githubToken}
              onChange={(e) => setGitHubToken(e.target.value)}
              placeholder="Optional. Needed for private repos or higher rate limits."
              className={inputClass}
              style={{ fontFamily: 'inherit' }}
            />
          </label>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-white/[0.05] px-3 py-1 text-[12px] font-600 text-text-2">
              Imported tasks land in backlog
            </span>
            {activeProjectFilter && projects[activeProjectFilter] && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-[12px] font-600 text-accent-bright">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: projects[activeProjectFilter].color || '#6366F1' }} />
                Project: {projects[activeProjectFilter].name}
              </span>
            )}
          </div>

          {githubImportError && (
            <div className="mt-4 rounded-[14px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-[13px] text-red-200">
              {githubImportError}
            </div>
          )}

          {githubImportResult && (
            <div className="mt-5 rounded-[18px] border border-white/[0.08] bg-white/[0.03] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-700 text-text">{githubImportResult.repo}</span>
                <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[11px] font-600 text-text-3">
                  {githubImportResult.fetched} fetched
                </span>
                <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] font-600 text-emerald-300">
                  {githubImportResult.created.length} created
                </span>
                <span className="rounded-full bg-amber-500/10 px-2 py-1 text-[11px] font-600 text-amber-300">
                  {githubImportResult.skipped.length} skipped
                </span>
              </div>

              {githubImportResult.created.length > 0 && (
                <div className="mt-4">
                  <p className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/60">Created</p>
                  <div className="mt-2 flex flex-col gap-2">
                    {githubImportResult.created.slice(0, 8).map((item) => (
                      item.url ? (
                        <a
                          key={`created-${item.taskId || item.number}`}
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[13px] text-text-2 no-underline transition-colors hover:bg-white/[0.05]"
                        >
                          #{item.number} {item.title}
                        </a>
                      ) : (
                        <div
                          key={`created-${item.taskId || item.number}`}
                          className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[13px] text-text-2"
                        >
                          #{item.number} {item.title}
                        </div>
                      )
                    ))}
                  </div>
                </div>
              )}

              {githubImportResult.skipped.length > 0 && (
                <div className="mt-4">
                  <p className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/60">Skipped existing</p>
                  <div className="mt-2 flex flex-col gap-2">
                    {githubImportResult.skipped.slice(0, 8).map((item) => (
                      item.url ? (
                        <a
                          key={`skipped-${item.taskId || item.number}`}
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[13px] text-text-3 no-underline transition-colors hover:bg-white/[0.05] hover:text-text-2"
                        >
                          #{item.number} {item.title}
                        </a>
                      ) : (
                        <div
                          key={`skipped-${item.taskId || item.number}`}
                          className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[13px] text-text-3"
                        >
                          #{item.number} {item.title}
                        </div>
                      )
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="mt-6 flex items-center justify-end gap-3">
            <button
              onClick={() => {
                setGitHubImportOpen(false)
                setGitHubImportError(null)
              }}
              className="px-4 py-2 rounded-[10px] border border-white/[0.08] bg-transparent text-[13px] font-600 text-text-3 transition-colors hover:bg-white/[0.04] hover:text-text-2"
              style={{ fontFamily: 'inherit' }}
            >
              Close
            </button>
            <button
              onClick={handleGitHubImport}
              disabled={githubImporting}
              className="px-5 py-2.5 rounded-[12px] border-none bg-accent-bright text-white text-[14px] font-700 transition-all disabled:cursor-not-allowed disabled:opacity-60"
              style={{ fontFamily: 'inherit' }}
            >
              {githubImporting ? 'Importing...' : 'Import issues'}
            </button>
          </div>
        </div>
      </BottomSheet>

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
