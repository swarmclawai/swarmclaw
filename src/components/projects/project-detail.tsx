'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { updateAgent } from '@/lib/agents'
import { toast } from 'sonner'
import type { Agent, BoardTask, Schedule } from '@/types'

function relativeDate(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const STATUS_STYLES: Record<string, string> = {
  backlog: 'bg-white/[0.06] text-text-3',
  queued: 'bg-amber-500/15 text-amber-400',
  running: 'bg-sky-500/15 text-sky-400',
  completed: 'bg-emerald-500/15 text-emerald-400',
  failed: 'bg-red-500/15 text-red-400',
  archived: 'bg-white/[0.04] text-text-3/50',
}

/** Inline picker to assign agents to a project */
function AssignAgentPicker({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const agents = useAppStore((s) => s.agents) as Record<string, Agent>
  const loadAgents = useAppStore((s) => s.loadAgents)
  const [query, setQuery] = useState('')

  const unassigned = Object.values(agents).filter((a) =>
    !a.trashedAt && a.projectId !== projectId && (!query || a.name.toLowerCase().includes(query.toLowerCase())),
  )

  const handleAssign = async (agentId: string) => {
    await updateAgent(agentId, { projectId })
    await loadAgents()
    toast.success('Agent assigned to project')
  }

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute left-0 top-full mt-2 z-50 w-[260px] rounded-[12px] bg-surface/95 backdrop-blur-xl border border-white/[0.1] shadow-[0_12px_40px_rgba(0,0,0,0.5)] overflow-hidden">
        <div className="p-2.5 border-b border-white/[0.06]">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents..."
            autoFocus
            className="w-full px-2.5 py-1.5 text-[12px] bg-white/[0.06] rounded-[8px] border border-white/[0.08] text-text placeholder:text-text-3/50 outline-none"
            style={{ fontFamily: 'inherit' }}
          />
        </div>
        <div className="max-h-[240px] overflow-y-auto p-1">
          {unassigned.length === 0 && (
            <div className="px-3 py-4 text-[11px] text-text-3/50 text-center">
              {query ? 'No matching agents' : 'All agents are already assigned'}
            </div>
          )}
          {unassigned.map((a) => (
            <button
              key={a.id}
              onClick={() => handleAssign(a.id)}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[8px] text-left hover:bg-white/[0.06] transition-colors cursor-pointer bg-transparent border-none"
              style={{ fontFamily: 'inherit' }}
            >
              <AgentAvatar seed={a.avatarSeed} avatarUrl={a.avatarUrl} name={a.name} size={22} />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-text truncate">{a.name}</div>
                <div className="text-[10px] text-text-3/40 truncate">{a.model || a.provider}</div>
              </div>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/30 shrink-0">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

export function ProjectDetail() {
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)
  const projects = useAppStore((s) => s.projects)
  const agents = useAppStore((s) => s.agents) as Record<string, Agent>
  const tasks = useAppStore((s) => s.tasks) as Record<string, BoardTask>
  const schedules = useAppStore((s) => s.schedules) as Record<string, Schedule>
  const loadAgents = useAppStore((s) => s.loadAgents)
  const setEditingProjectId = useAppStore((s) => s.setEditingProjectId)
  const setProjectSheetOpen = useAppStore((s) => s.setProjectSheetOpen)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)
  const setEditingTaskId = useAppStore((s) => s.setEditingTaskId)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)
  const setEditingScheduleId = useAppStore((s) => s.setEditingScheduleId)
  const setScheduleSheetOpen = useAppStore((s) => s.setScheduleSheetOpen)

  const [assignPickerOpen, setAssignPickerOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(intervalId)
  }, [])

  const project = activeProjectFilter ? projects[activeProjectFilter] : null

  const projectAgents = useMemo(
    () => Object.values(agents).filter((a) => a.projectId === activeProjectFilter && !a.trashedAt),
    [agents, activeProjectFilter],
  )

  const projectTasks = useMemo(
    () => Object.values(tasks)
      .filter((t) => t.projectId === activeProjectFilter)
      .sort((a, b) => b.updatedAt - a.updatedAt),
    [tasks, activeProjectFilter],
  )

  const projectSchedules = useMemo(
    () => Object.values(schedules).filter((s) => s.projectId === activeProjectFilter),
    [schedules, activeProjectFilter],
  )

  const completedTasks = projectTasks.filter((t) => t.status === 'completed').length
  const totalTasks = projectTasks.length
  const progressPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0

  // Task status breakdown for mini-chart
  const tasksByStatus = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const t of projectTasks) {
      counts[t.status] = (counts[t.status] || 0) + 1
    }
    return counts
  }, [projectTasks])

  // Recent activity: merge tasks & schedules sorted by updatedAt
  const recentActivity = useMemo(() => {
    const items: { id: string; type: 'task' | 'schedule' | 'agent'; name: string; status?: string; time: number }[] = []
    for (const t of projectTasks.slice(0, 10)) {
      items.push({ id: t.id, type: 'task', name: t.title, status: t.status, time: t.updatedAt })
    }
    for (const s of projectSchedules) {
      if (s.lastRunAt) items.push({ id: s.id, type: 'schedule', name: s.name, status: s.status, time: s.lastRunAt })
    }
    for (const a of projectAgents.slice(0, 5)) {
      if (a.lastUsedAt) items.push({ id: a.id, type: 'agent', name: a.name, time: a.lastUsedAt })
    }
    return items.sort((a, b) => b.time - a.time).slice(0, 12)
  }, [projectTasks, projectSchedules, projectAgents])

  const approvalTasks = useMemo(
    () => projectTasks.filter((task) => !!task.pendingApproval),
    [projectTasks],
  )

  const blockedTasks = useMemo(
    () => projectTasks.filter((task) => (task.blockedBy?.length || 0) > 0),
    [projectTasks],
  )

  const overdueTasks = useMemo(
    () => projectTasks.filter((task) => !!task.dueAt && task.dueAt < now && task.status !== 'completed' && task.status !== 'archived'),
    [now, projectTasks],
  )

  const staleTasks = useMemo(
    () => projectTasks.filter((task) => task.status !== 'completed' && task.status !== 'archived' && now - task.updatedAt > 3 * 24 * 60 * 60 * 1000),
    [now, projectTasks],
  )

  const overdueSchedules = useMemo(
    () => projectSchedules.filter((schedule) => schedule.status === 'active' && !!schedule.nextRunAt && schedule.nextRunAt < now),
    [now, projectSchedules],
  )

  const nextScheduledRun = useMemo(
    () => projectSchedules
      .filter((schedule) => schedule.status === 'active' && !!schedule.nextRunAt && schedule.nextRunAt >= now)
      .sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0))[0] || null,
    [now, projectSchedules],
  )

  const busiestAgent = useMemo(() => {
    return projectAgents
      .map((agent) => ({
        agent,
        taskCount: projectTasks.filter((task) => task.agentId === agent.id && task.status !== 'completed' && task.status !== 'archived').length,
      }))
      .sort((a, b) => b.taskCount - a.taskCount)[0] || null
  }, [projectAgents, projectTasks])

  const attentionItems = useMemo(() => {
    const seen = new Set<string>()
    const items: Array<{ id: string; label: string; detail: string; tone: string; onClick: () => void }> = []
    for (const task of approvalTasks.slice(0, 2)) {
      seen.add(task.id)
      items.push({
        id: `approval-${task.id}`,
        label: task.title,
        detail: 'Awaiting tool approval',
        tone: 'text-amber-400',
        onClick: () => { setEditingTaskId(task.id); setTaskSheetOpen(true) },
      })
    }
    for (const task of blockedTasks.slice(0, 2)) {
      if (seen.has(task.id)) continue
      seen.add(task.id)
      items.push({
        id: `blocked-${task.id}`,
        label: task.title,
        detail: `${task.blockedBy?.length || 0} blocker${task.blockedBy?.length === 1 ? '' : 's'}`,
        tone: 'text-rose-400',
        onClick: () => { setEditingTaskId(task.id); setTaskSheetOpen(true) },
      })
    }
    if (staleTasks[0] && !seen.has(staleTasks[0].id)) {
      seen.add(staleTasks[0].id)
      items.push({
        id: `stale-${staleTasks[0].id}`,
        label: staleTasks[0].title,
        detail: 'No recent progress in 3+ days',
        tone: 'text-sky-400',
        onClick: () => { setEditingTaskId(staleTasks[0].id); setTaskSheetOpen(true) },
      })
    }
    if (overdueSchedules[0]) {
      items.push({
        id: `schedule-${overdueSchedules[0].id}`,
        label: overdueSchedules[0].name,
        detail: 'Schedule missed its next run',
        tone: 'text-red-400',
        onClick: () => { setEditingScheduleId(overdueSchedules[0].id); setScheduleSheetOpen(true) },
      })
    }
    return items.slice(0, 5)
  }, [approvalTasks, blockedTasks, overdueSchedules, setEditingScheduleId, setEditingTaskId, setScheduleSheetOpen, setTaskSheetOpen, staleTasks])

  const handleUnassignAgent = async (agentId: string) => {
    await updateAgent(agentId, { projectId: undefined })
    await loadAgents()
    toast.success('Agent removed from project')
  }

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center px-8">
        <div className="text-center max-w-[420px]">
          <div className="w-14 h-14 rounded-[16px] bg-white/[0.04] flex items-center justify-center mx-auto mb-4">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3/40">
              <path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7-7H4a2 2 0 0 0-2 2v17Z" />
              <path d="M14 2v7h7" />
            </svg>
          </div>
          <h2 className="font-display text-[20px] font-700 text-text mb-2 tracking-[-0.02em]">
            Select a Project
          </h2>
          <p className="text-[14px] text-text-3/60">
            Choose a project from the list to see its agents, tasks, and activity.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-8">

        {/* Project header */}
        <div className="flex items-start gap-5 mb-8">
          <div
            className="w-12 h-12 rounded-[14px] flex items-center justify-center shrink-0 text-[20px] font-700 text-white/90"
            style={{ backgroundColor: project.color || '#6366F1' }}
          >
            {project.name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="font-display text-[24px] font-700 text-text tracking-[-0.02em] truncate">
                {project.name}
              </h1>
              <button
                onClick={() => { setEditingProjectId(project.id); setProjectSheetOpen(true) }}
                className="shrink-0 p-1.5 rounded-[8px] hover:bg-white/[0.06] transition-colors cursor-pointer bg-transparent border-none text-text-3/50 hover:text-text-2"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                </svg>
              </button>
            </div>
            {project.description && (
              <p className="text-[14px] text-text-3/70 mt-1.5 leading-relaxed">{project.description}</p>
            )}
            <p className="text-[11px] text-text-3/40 mt-2">
              Created {relativeDate(project.createdAt)} &middot; Updated {relativeDate(project.updatedAt)}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_280px] gap-4 mb-8">
          <div className="rounded-[16px] border border-white/[0.06] bg-white/[0.02] px-5 py-5">
            <div className="flex items-center justify-between gap-4 mb-4">
              <div>
                <h2 className="font-display text-[18px] font-700 tracking-[-0.02em] text-text">Project Health</h2>
                <p className="text-[12px] text-text-3/60 mt-1">Surface blockers and the next useful action before digging into the full history.</p>
              </div>
              <button
                onClick={() => setActiveView('tasks')}
                className="shrink-0 px-3 py-2 rounded-[10px] bg-white/[0.04] text-[12px] font-600 text-text-2 hover:bg-white/[0.08] transition-all cursor-pointer border-none"
                style={{ fontFamily: 'inherit' }}
              >
                Open Task Board
              </button>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                { label: 'Awaiting Approval', value: approvalTasks.length, tone: 'text-amber-400', hint: 'Tasks paused on approval' },
                { label: 'Blocked', value: blockedTasks.length, tone: 'text-rose-400', hint: 'Tasks waiting on dependencies' },
                { label: 'Overdue', value: overdueTasks.length + overdueSchedules.length, tone: 'text-red-400', hint: 'Tasks or schedules behind plan' },
                { label: 'Stale Tasks', value: staleTasks.length, tone: 'text-sky-400', hint: 'No meaningful progress in 3+ days' },
              ].map((item) => (
                <div key={item.label} className="rounded-[12px] border border-white/[0.06] bg-surface/60 px-4 py-3">
                  <div className={`text-[22px] font-display font-700 tracking-[-0.02em] ${item.tone}`}>{item.value}</div>
                  <div className="text-[11px] font-600 text-text-2 mt-0.5">{item.label}</div>
                  <p className="text-[10px] text-text-3/45 mt-1 leading-relaxed">{item.hint}</p>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2 mt-4">
              {busiestAgent?.agent && (
                <button
                  onClick={() => { setCurrentAgent(busiestAgent.agent.id); setActiveView('agents') }}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-[10px] bg-accent-soft text-[12px] font-600 text-accent-bright hover:bg-accent-bright/15 transition-all cursor-pointer border-none"
                  style={{ fontFamily: 'inherit' }}
                >
                  <AgentAvatar seed={busiestAgent.agent.avatarSeed} avatarUrl={busiestAgent.agent.avatarUrl} name={busiestAgent.agent.name} size={18} />
                  Open busiest agent
                </button>
              )}
              {(approvalTasks[0] || blockedTasks[0] || overdueTasks[0]) && (
                <button
                  onClick={() => {
                    const nextTask = approvalTasks[0] || blockedTasks[0] || overdueTasks[0]
                    if (!nextTask) return
                    setEditingTaskId(nextTask.id)
                    setTaskSheetOpen(true)
                  }}
                  className="px-3 py-2 rounded-[10px] bg-white/[0.04] text-[12px] font-600 text-text-2 hover:bg-white/[0.08] transition-all cursor-pointer border-none"
                  style={{ fontFamily: 'inherit' }}
                >
                  Review next task
                </button>
              )}
              {nextScheduledRun && (
                <button
                  onClick={() => { setEditingScheduleId(nextScheduledRun.id); setScheduleSheetOpen(true) }}
                  className="px-3 py-2 rounded-[10px] bg-white/[0.04] text-[12px] font-600 text-text-2 hover:bg-white/[0.08] transition-all cursor-pointer border-none"
                  style={{ fontFamily: 'inherit' }}
                >
                  Next run {relativeDate(nextScheduledRun.nextRunAt || now)}
                </button>
              )}
            </div>
          </div>

          <div className="rounded-[16px] border border-white/[0.06] bg-white/[0.02] px-5 py-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/60">Needs Attention</h3>
              <span className="text-[11px] text-text-3/40">{attentionItems.length || 0} items</span>
            </div>
            {attentionItems.length === 0 ? (
              <div className="rounded-[12px] border border-dashed border-white/[0.08] px-4 py-6 text-center">
                <p className="text-[12px] text-text-3/45">No urgent blockers right now.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {attentionItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={item.onClick}
                    className="w-full rounded-[12px] border border-white/[0.06] bg-surface/60 px-3.5 py-3 text-left hover:bg-white/[0.04] transition-all cursor-pointer"
                    style={{ fontFamily: 'inherit' }}
                  >
                    <div className={`text-[11px] font-700 uppercase tracking-[0.08em] ${item.tone}`}>{item.detail}</div>
                    <div className="text-[13px] font-600 text-text mt-1 line-clamp-2">{item.label}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-4 gap-3 mb-8">
          {[
            { label: 'Agents', value: projectAgents.length, color: '#818CF8' },
            { label: 'Tasks', value: totalTasks, color: project.color || '#6366F1' },
            { label: 'Completed', value: completedTasks, color: '#22C55E' },
            { label: 'Schedules', value: projectSchedules.length, color: '#F59E0B' },
          ].map((stat) => (
            <div key={stat.label} className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-4 py-3.5">
              <div className="text-[22px] font-700 font-display tracking-[-0.02em]" style={{ color: stat.color }}>
                {stat.value}
              </div>
              <div className="text-[11px] text-text-3/50 font-500 mt-0.5">{stat.label}</div>
            </div>
          ))}
        </div>

        {/* Progress bar + task breakdown */}
        {totalTasks > 0 && (
          <div className="mb-8 rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-5 py-4">
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

        {/* Agents section */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/60">
              Agents ({projectAgents.length})
            </h3>
            <div className="relative">
              <button
                onClick={() => setAssignPickerOpen(!assignPickerOpen)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer border-none"
                style={{ fontFamily: 'inherit' }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Assign Agent
              </button>
              {assignPickerOpen && (
                <AssignAgentPicker
                  projectId={project.id}
                  onClose={() => setAssignPickerOpen(false)}
                />
              )}
            </div>
          </div>
          {projectAgents.length === 0 ? (
            <div className="rounded-[12px] border border-dashed border-white/[0.08] px-5 py-8 text-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3/30 mx-auto mb-2">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <line x1="23" y1="11" x2="17" y2="11" />
              </svg>
              <p className="text-[12px] text-text-3/40">No agents assigned yet.</p>
              <p className="text-[11px] text-text-3/30 mt-1">Click &ldquo;Assign Agent&rdquo; to add agents to this project.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {projectAgents.map((agent) => (
                <div
                  key={agent.id}
                  className="group/agent flex items-center gap-3 px-4 py-3 rounded-[12px] border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/[0.1] transition-all"
                >
                  <button
                    onClick={() => { setCurrentAgent(agent.id); setActiveView('agents') }}
                    className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer bg-transparent border-none text-left p-0"
                    style={{ fontFamily: 'inherit' }}
                  >
                    <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={28} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-600 text-text truncate">{agent.name}</div>
                      <div className="text-[11px] text-text-3/50 truncate">{agent.model || agent.provider}</div>
                    </div>
                  </button>
                  {agent.lastUsedAt && (
                    <span className="text-[10px] text-text-3/30 shrink-0">{relativeDate(agent.lastUsedAt)}</span>
                  )}
                  <button
                    onClick={() => handleUnassignAgent(agent.id)}
                    title="Remove from project"
                    className="opacity-0 group-hover/agent:opacity-100 p-1 rounded-[6px] hover:bg-red-500/10 text-text-3/30 hover:text-red-400 transition-all cursor-pointer bg-transparent border-none shrink-0"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Tasks section */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/60">
              Tasks ({totalTasks})
            </h3>
            <button
              onClick={() => { setEditingTaskId(null); setTaskSheetOpen(true) }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer border-none"
              style={{ fontFamily: 'inherit' }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New Task
            </button>
          </div>
          {projectTasks.length === 0 ? (
            <div className="rounded-[12px] border border-dashed border-white/[0.08] px-5 py-8 text-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3/30 mx-auto mb-2">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
              <p className="text-[12px] text-text-3/40">No tasks in this project yet.</p>
              <p className="text-[11px] text-text-3/30 mt-1">Create tasks and assign them to this project from the task board.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {projectTasks.slice(0, 10).map((task) => {
                const agent = task.agentId ? agents[task.agentId] : null
                return (
                  <button
                    key={task.id}
                    onClick={() => { setEditingTaskId(task.id); setTaskSheetOpen(true) }}
                    className="flex items-center gap-3 px-4 py-3 rounded-[10px] border border-white/[0.04] bg-white/[0.01] hover:bg-white/[0.04] hover:border-white/[0.08] transition-all cursor-pointer text-left w-full"
                    style={{ fontFamily: 'inherit' }}
                  >
                    <span className={`shrink-0 px-2 py-0.5 rounded-[5px] text-[10px] font-600 uppercase tracking-wider ${STATUS_STYLES[task.status] || STATUS_STYLES.backlog}`}>
                      {task.status}
                    </span>
                    <span className="text-[13px] text-text truncate flex-1">{task.title}</span>
                    {agent && (
                      <span className="shrink-0 flex items-center gap-1.5 text-[11px] text-text-3/40">
                        <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={16} />
                        {agent.name}
                      </span>
                    )}
                    <span className="text-[10px] text-text-3/30 shrink-0">{relativeDate(task.updatedAt)}</span>
                  </button>
                )
              })}
              {projectTasks.length > 10 && (
                <button
                  onClick={() => setActiveView('tasks')}
                  className="text-[11px] text-accent-bright/70 hover:text-accent-bright text-center py-2 cursor-pointer bg-transparent border-none transition-colors"
                  style={{ fontFamily: 'inherit' }}
                >
                  View all {projectTasks.length} tasks on board
                </button>
              )}
            </div>
          )}
        </div>

        {/* Schedules section */}
        {(projectSchedules.length > 0 || projectAgents.length > 0) && (
          <div className="mb-8">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/60">
                Schedules ({projectSchedules.length})
              </h3>
              <button
                onClick={() => { setEditingScheduleId(null); setScheduleSheetOpen(true) }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[11px] font-600 text-accent-bright bg-accent-soft hover:bg-accent-bright/15 transition-all cursor-pointer border-none"
                style={{ fontFamily: 'inherit' }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                New Schedule
              </button>
            </div>
            {projectSchedules.length === 0 ? (
              <div className="rounded-[12px] border border-dashed border-white/[0.08] px-5 py-6 text-center">
                <p className="text-[12px] text-text-3/40">No schedules yet.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {projectSchedules.map((schedule) => {
                  const agent = schedule.agentId ? agents[schedule.agentId] : null
                  return (
                    <button
                      key={schedule.id}
                      onClick={() => { setEditingScheduleId(schedule.id); setScheduleSheetOpen(true) }}
                      className="flex items-center gap-3 px-4 py-3 rounded-[10px] border border-white/[0.04] bg-white/[0.01] hover:bg-white/[0.04] hover:border-white/[0.08] transition-all cursor-pointer text-left w-full"
                      style={{ fontFamily: 'inherit' }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-amber-400/60 shrink-0">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                      <span className="text-[13px] text-text truncate flex-1">{schedule.name}</span>
                      <span className={`shrink-0 px-2 py-0.5 rounded-[5px] text-[10px] font-600 uppercase tracking-wider ${
                        schedule.status === 'active' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/[0.06] text-text-3'
                      }`}>
                        {schedule.status}
                      </span>
                      {agent && (
                        <span className="shrink-0 flex items-center gap-1.5 text-[11px] text-text-3/40">
                          <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={16} />
                        </span>
                      )}
                      {schedule.nextRunAt && (
                        <span className="text-[10px] text-text-3/30 shrink-0">
                          next: {relativeDate(schedule.nextRunAt)}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Recent activity */}
        {recentActivity.length > 0 && (
          <div className="mb-8">
            <h3 className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/60 mb-3">
              Recent Activity
            </h3>
            <div className="relative pl-5">
              <div className="absolute left-[7px] top-2 bottom-2 w-px bg-white/[0.06]" />
              <div className="flex flex-col gap-3">
                {recentActivity.map((item) => (
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
          </div>
        )}

      </div>
    </div>
  )
}
