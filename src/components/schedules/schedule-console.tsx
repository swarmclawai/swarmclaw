'use client'

import { useEffect, useMemo, useState, type ButtonHTMLAttributes } from 'react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { SearchInput } from '@/components/ui/search-input'
import { FilterPill } from '@/components/ui/filter-pill'
import { SectionHeader } from '@/components/ui/section-header'
import { useNow } from '@/hooks/use-now'
import { useWs } from '@/hooks/use-ws'
import { useAppStore } from '@/stores/use-app-store'
import { archiveSchedule, purgeSchedule, restoreSchedule, runSchedule, updateSchedule } from '@/lib/schedules/schedules'
import { cronToHuman } from '@/lib/schedules/cron-human'
import { timeAgo, timeUntil } from '@/lib/time-format'
import type { BoardTask, Schedule, ScheduleStatus } from '@/types'
import { toast } from 'sonner'

type ScheduleScope = 'live' | 'archived' | 'runs'
type ScheduleFilterStatus = 'all' | ScheduleStatus
type ScheduleRunStatusFilter = 'all' | Extract<BoardTask['status'], 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'>
type ScheduleCadenceFilter = 'all' | Schedule['scheduleType']
type ScheduleDeliveryFilter = 'all' | 'ok' | 'error' | 'unknown'
type ScheduleSortBy = 'nextRunAt' | 'lastRunAt' | 'updatedAt' | 'name'

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-emerald-500/12 text-emerald-400 border-emerald-500/20',
  paused: 'bg-amber-500/12 text-amber-400 border-amber-500/20',
  completed: 'bg-sky-500/12 text-sky-400 border-sky-500/20',
  failed: 'bg-red-500/12 text-red-400 border-red-500/20',
  archived: 'bg-white/[0.05] text-text-3 border-white/[0.08]',
  queued: 'bg-amber-500/12 text-amber-400 border-amber-500/20',
  running: 'bg-accent-soft text-accent-bright border-accent-bright/20',
  cancelled: 'bg-white/[0.05] text-text-3 border-white/[0.08]',
}

function badgeClass(status: string): string {
  return STATUS_STYLES[status] || STATUS_STYLES.archived
}

function formatScheduleCadence(schedule: Schedule): string {
  if (schedule.scheduleType === 'cron' && schedule.cron) {
    return cronToHuman(schedule.cron)
  }
  if (schedule.scheduleType === 'interval' && schedule.intervalMs) {
    const minutes = Math.round(schedule.intervalMs / 60_000)
    if (minutes >= 60) return `Every ${Math.round(minutes / 60)}h`
    return `Every ${minutes}m`
  }
  if (schedule.scheduleType === 'once') {
    return schedule.runAt ? `Once · ${new Date(schedule.runAt).toLocaleString()}` : 'Once'
  }
  return schedule.scheduleType
}

function scheduleTimingLabel(schedule: Schedule, now: number | null): string {
  if (schedule.status === 'archived') {
    return schedule.archivedAt ? `Archived ${timeAgo(schedule.archivedAt, now)}` : 'Archived'
  }
  if (schedule.status === 'failed') {
    return schedule.lastDeliveredAt ? `Last failed ${timeAgo(schedule.lastDeliveredAt, now)}` : 'Failed'
  }
  if (schedule.status === 'completed') {
    return schedule.lastRunAt ? `Completed ${timeAgo(schedule.lastRunAt, now)}` : 'Completed'
  }
  if (schedule.nextRunAt) {
    return schedule.nextRunAt > (now || 0)
      ? `Next ${timeUntil(schedule.nextRunAt, now)}`
      : 'Overdue'
  }
  return 'Not scheduled'
}

function runPreview(task: BoardTask): string {
  const result = typeof task.result === 'string' ? task.result.trim() : ''
  const error = typeof task.error === 'string' ? task.error.trim() : ''
  return (result || error || task.description || '').slice(0, 180) || 'No run summary yet.'
}

function ActionButton(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'default' | 'danger' },
) {
  const { tone = 'default', className = '', ...rest } = props
  return (
    <button
      {...rest}
      className={[
        'px-2.5 py-1.5 rounded-[10px] text-[12px] font-600 cursor-pointer transition-all border',
        tone === 'danger'
          ? 'border-red-500/20 text-red-400 hover:bg-red-500/10'
          : 'border-white/[0.08] text-text-2 hover:bg-white/[0.04]',
        className,
      ].join(' ')}
      style={{ fontFamily: 'inherit' }}
    />
  )
}

export function ScheduleConsole() {
  const now = useNow()
  const schedules = useAppStore((s) => s.schedules)
  const tasks = useAppStore((s) => s.tasks)
  const agents = useAppStore((s) => s.agents)
  const activeProjectFilter = useAppStore((s) => s.activeProjectFilter)
  const loadSchedules = useAppStore((s) => s.loadSchedules)
  const loadTasks = useAppStore((s) => s.loadTasks)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const setScheduleSheetOpen = useAppStore((s) => s.setScheduleSheetOpen)
  const setEditingScheduleId = useAppStore((s) => s.setEditingScheduleId)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)
  const setEditingTaskId = useAppStore((s) => s.setEditingTaskId)

  const [scope, setScope] = useState<ScheduleScope>('live')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<ScheduleFilterStatus>('all')
  const [runStatusFilter, setRunStatusFilter] = useState<ScheduleRunStatusFilter>('all')
  const [cadenceFilter, setCadenceFilter] = useState<ScheduleCadenceFilter>('all')
  const [deliveryFilter, setDeliveryFilter] = useState<ScheduleDeliveryFilter>('all')
  const [agentFilter, setAgentFilter] = useState('all')
  const [sortBy, setSortBy] = useState<ScheduleSortBy>('nextRunAt')
  const [busyId, setBusyId] = useState('')

  useEffect(() => {
    void Promise.all([loadSchedules(), loadTasks(), loadAgents()])
  }, [loadAgents, loadSchedules, loadTasks])
  useWs('schedules', loadSchedules, 5_000)
  useWs('tasks', loadTasks, 5_000)

  useEffect(() => {
    if (scope === 'runs') {
      setStatusFilter('all')
      return
    }
    setRunStatusFilter('all')
    if (scope === 'archived' && statusFilter !== 'all' && statusFilter !== 'archived') {
      setStatusFilter('all')
    }
    if (scope === 'live' && statusFilter === 'archived') {
      setStatusFilter('all')
    }
  }, [scope, statusFilter])

  const scheduleRows = useMemo(() => Object.values(schedules), [schedules])
  const runRows = useMemo(() => Object.values(tasks).filter((task) => task.sourceType === 'schedule'), [tasks])
  const projectScopedSchedules = useMemo(
    () => scheduleRows.filter((schedule) => !activeProjectFilter || schedule.projectId === activeProjectFilter),
    [activeProjectFilter, scheduleRows],
  )
  const projectScopedRuns = useMemo(
    () => runRows.filter((task) => !activeProjectFilter || task.projectId === activeProjectFilter),
    [activeProjectFilter, runRows],
  )

  const summary = useMemo(() => {
    const live = projectScopedSchedules.filter((schedule) => schedule.status !== 'archived')
    const archived = projectScopedSchedules.filter((schedule) => schedule.status === 'archived')
    const active = live.filter((schedule) => schedule.status === 'active')
    const dueSoon = active.filter((schedule) => schedule.nextRunAt && schedule.nextRunAt > (now || 0) && schedule.nextRunAt - (now || 0) <= 24 * 60 * 60 * 1000).length
    const attention = live.filter((schedule) =>
      schedule.status === 'failed'
      || (schedule.status === 'active' && !!schedule.nextRunAt && !!now && schedule.nextRunAt <= now),
    ).length
    return {
      active: active.length,
      attention,
      dueSoon,
      archived: archived.length,
    }
  }, [now, projectScopedSchedules])

  const filteredSchedules = useMemo(() => {
    const q = search.trim().toLowerCase()
    return projectScopedSchedules
      .filter((schedule) => scope === 'archived' ? schedule.status === 'archived' : schedule.status !== 'archived')
      .filter((schedule) => {
        if (statusFilter !== 'all' && schedule.status !== statusFilter) return false
        if (cadenceFilter !== 'all' && schedule.scheduleType !== cadenceFilter) return false
        if (agentFilter !== 'all' && schedule.agentId !== agentFilter) return false
        if (deliveryFilter !== 'all') {
          const deliveryStatus = schedule.lastDeliveryStatus || 'unknown'
          if (deliveryStatus !== deliveryFilter) return false
        }
        if (!q) return true
        const agentName = agents[schedule.agentId]?.name || ''
        const haystack = [
          schedule.name,
          schedule.taskPrompt,
          schedule.followupSenderName,
          agentName,
        ].filter(Boolean).join(' ').toLowerCase()
        return haystack.includes(q)
      })
      .sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name)
        if (sortBy === 'lastRunAt') return (b.lastRunAt || 0) - (a.lastRunAt || 0)
        if (sortBy === 'updatedAt') return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
        const aNext = a.nextRunAt ?? Number.MAX_SAFE_INTEGER
        const bNext = b.nextRunAt ?? Number.MAX_SAFE_INTEGER
        return aNext - bNext
      })
  }, [agentFilter, agents, cadenceFilter, deliveryFilter, projectScopedSchedules, scope, search, sortBy, statusFilter])

  const filteredRuns = useMemo(() => {
    const q = search.trim().toLowerCase()
    return projectScopedRuns
      .filter((task) => {
        if (runStatusFilter !== 'all' && task.status !== runStatusFilter) return false
        if (agentFilter !== 'all' && task.agentId !== agentFilter) return false
        if (cadenceFilter !== 'all') {
          const sourceSchedule = typeof task.sourceScheduleId === 'string' ? schedules[task.sourceScheduleId] : null
          if (!sourceSchedule || sourceSchedule.scheduleType !== cadenceFilter) return false
        }
        if (!q) return true
        const agentName = agents[task.agentId]?.name || ''
        const sourceSchedule = typeof task.sourceScheduleName === 'string' ? task.sourceScheduleName : ''
        const haystack = [
          task.title,
          task.description,
          sourceSchedule,
          task.result,
          task.error,
          agentName,
        ].filter(Boolean).join(' ').toLowerCase()
        return haystack.includes(q)
      })
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
  }, [agentFilter, agents, cadenceFilter, projectScopedRuns, runStatusFilter, schedules, search])

  const handleArchive = async (scheduleId: string) => {
    setBusyId(scheduleId)
    try {
      const result = await archiveSchedule(scheduleId)
      await Promise.all([loadSchedules(), loadTasks()])
      const cancelledCount = Array.isArray(result.cancelledTaskIds) ? result.cancelledTaskIds.length : 0
      toast.success(cancelledCount > 0 ? `Schedule archived and ${cancelledCount} task(s) cancelled` : 'Schedule archived')
      if (scope === 'live') setScope('archived')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to archive schedule')
    } finally {
      setBusyId('')
    }
  }

  const handleRestore = async (scheduleId: string) => {
    setBusyId(scheduleId)
    try {
      await restoreSchedule(scheduleId)
      await loadSchedules()
      toast.success('Schedule restored')
      setScope('live')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to restore schedule')
    } finally {
      setBusyId('')
    }
  }

  const handlePurge = async (scheduleId: string) => {
    if (typeof window !== 'undefined' && !window.confirm('Permanently delete this archived schedule?')) return
    setBusyId(scheduleId)
    try {
      await purgeSchedule(scheduleId)
      await loadSchedules()
      toast.success('Archived schedule purged')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to purge schedule')
    } finally {
      setBusyId('')
    }
  }

  const handleRunNow = async (scheduleId: string) => {
    setBusyId(scheduleId)
    try {
      const result = await runSchedule(scheduleId)
      if ('queued' in result && result.queued === false) toast.message('Schedule already has an in-flight run')
      else toast.success('Schedule run queued')
      await Promise.all([loadSchedules(), loadTasks()])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to run schedule')
    } finally {
      setBusyId('')
    }
  }

  const handleToggleStatus = async (schedule: Schedule) => {
    const nextStatus = schedule.status === 'active' ? 'paused' : 'active'
    setBusyId(schedule.id)
    try {
      await updateSchedule(schedule.id, { status: nextStatus })
      await loadSchedules()
      toast.success(`Schedule ${nextStatus}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update schedule')
    } finally {
      setBusyId('')
    }
  }

  const openSchedule = (scheduleId: string) => {
    setEditingScheduleId(scheduleId)
    setScheduleSheetOpen(true)
  }

  const openTask = (taskId: string) => {
    setEditingTaskId(taskId)
    setTaskSheetOpen(true)
  }

  const resetFilters = () => {
    setSearch('')
    setStatusFilter('all')
    setRunStatusFilter('all')
    setCadenceFilter('all')
    setDeliveryFilter('all')
    setAgentFilter('all')
    setSortBy('nextRunAt')
  }

  const scopeCount = scope === 'runs' ? filteredRuns.length : filteredSchedules.length

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 py-5 max-w-[1200px] mx-auto">
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-6">
          {[
            { label: 'Active', value: summary.active, tone: 'text-emerald-400' },
            { label: 'Needs Attention', value: summary.attention, tone: summary.attention > 0 ? 'text-red-400' : 'text-text-2' },
            { label: 'Due Soon', value: summary.dueSoon, tone: 'text-accent-bright' },
            { label: 'Archived', value: summary.archived, tone: 'text-text-2' },
          ].map((card) => (
            <div key={card.label} className="rounded-[18px] border border-white/[0.06] bg-surface px-4 py-4">
              <div className="text-[11px] uppercase tracking-[0.08em] text-text-3/60 font-700">{card.label}</div>
              <div className={`mt-2 text-[26px] font-display font-700 ${card.tone}`}>{card.value}</div>
            </div>
          ))}
        </div>

        <div className="rounded-[22px] border border-white/[0.06] bg-raised/70 overflow-hidden">
          <div className="px-5 pt-5 pb-4 border-b border-white/[0.05]">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <SectionHeader label="Schedule Console" count={scopeCount} className="mb-2" />
                <div className="flex flex-wrap gap-2">
                  <FilterPill label="Live" active={scope === 'live'} onClick={() => setScope('live')} />
                  <FilterPill label="Archived" active={scope === 'archived'} onClick={() => setScope('archived')} />
                  <FilterPill label="Runs" active={scope === 'runs'} onClick={() => setScope('runs')} />
                </div>
              </div>
              <div className="w-full lg:max-w-[360px]">
                <SearchInput
                  size="sm"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onClear={() => setSearch('')}
                  placeholder={scope === 'runs' ? 'Search runs, schedules, or agents...' : 'Search schedules, agents, or recipients...'}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-3 mt-4">
              <label className="text-[12px] text-text-3/70">
                <span className="block mb-1.5 font-600 uppercase tracking-[0.08em] text-[10px]">Status</span>
                {scope === 'runs' ? (
                  <select
                    value={runStatusFilter}
                    onChange={(e) => setRunStatusFilter(e.target.value as ScheduleRunStatusFilter)}
                    className="w-full px-3 py-2.5 rounded-[12px] border border-white/[0.06] bg-surface text-text-2"
                  >
                    <option value="all">All runs</option>
                    <option value="queued">Queued</option>
                    <option value="running">Running</option>
                    <option value="completed">Completed</option>
                    <option value="failed">Failed</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                ) : (
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as ScheduleFilterStatus)}
                    className="w-full px-3 py-2.5 rounded-[12px] border border-white/[0.06] bg-surface text-text-2"
                  >
                    <option value="all">All statuses</option>
                    {scope === 'archived'
                      ? <option value="archived">Archived</option>
                      : (
                        <>
                          <option value="active">Active</option>
                          <option value="paused">Paused</option>
                          <option value="completed">Completed</option>
                          <option value="failed">Failed</option>
                        </>
                      )}
                  </select>
                )}
              </label>

              <label className="text-[12px] text-text-3/70">
                <span className="block mb-1.5 font-600 uppercase tracking-[0.08em] text-[10px]">Cadence</span>
                <select
                  value={cadenceFilter}
                  onChange={(e) => setCadenceFilter(e.target.value as ScheduleCadenceFilter)}
                  className="w-full px-3 py-2.5 rounded-[12px] border border-white/[0.06] bg-surface text-text-2"
                >
                  <option value="all">All cadence</option>
                  <option value="cron">Cron</option>
                  <option value="interval">Interval</option>
                  <option value="once">Once</option>
                </select>
              </label>

              <label className="text-[12px] text-text-3/70">
                <span className="block mb-1.5 font-600 uppercase tracking-[0.08em] text-[10px]">Agent</span>
                <select
                  value={agentFilter}
                  onChange={(e) => setAgentFilter(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-[12px] border border-white/[0.06] bg-surface text-text-2"
                >
                  <option value="all">All agents</option>
                  {Object.values(agents)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((agent) => (
                      <option key={agent.id} value={agent.id}>{agent.name}</option>
                    ))}
                </select>
              </label>

              {scope !== 'runs' ? (
                <label className="text-[12px] text-text-3/70">
                  <span className="block mb-1.5 font-600 uppercase tracking-[0.08em] text-[10px]">Delivery</span>
                  <select
                    value={deliveryFilter}
                    onChange={(e) => setDeliveryFilter(e.target.value as ScheduleDeliveryFilter)}
                    className="w-full px-3 py-2.5 rounded-[12px] border border-white/[0.06] bg-surface text-text-2"
                  >
                    <option value="all">Any delivery</option>
                    <option value="ok">Healthy</option>
                    <option value="error">Errors</option>
                    <option value="unknown">No data</option>
                  </select>
                </label>
              ) : <div />}

              <label className="text-[12px] text-text-3/70">
                <span className="block mb-1.5 font-600 uppercase tracking-[0.08em] text-[10px]">Sort</span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as ScheduleSortBy)}
                  className="w-full px-3 py-2.5 rounded-[12px] border border-white/[0.06] bg-surface text-text-2"
                >
                  <option value="nextRunAt">Next run</option>
                  <option value="lastRunAt">Last run</option>
                  <option value="updatedAt">Recently updated</option>
                  <option value="name">Name</option>
                </select>
              </label>

              <div className="flex items-end">
                <ActionButton onClick={resetFilters} className="w-full justify-center">Reset Filters</ActionButton>
              </div>
            </div>
          </div>

          {scope === 'runs' ? (
            <div className="divide-y divide-white/[0.05]">
              {filteredRuns.length === 0 ? (
                <div className="px-5 py-10 text-center text-text-3/60">No schedule runs match the current filters.</div>
              ) : filteredRuns.map((task) => {
                const agent = agents[task.agentId]
                const sourceSchedule = typeof task.sourceScheduleId === 'string' ? schedules[task.sourceScheduleId] : null
                return (
                  <div key={task.id} className="px-5 py-4 hover:bg-white/[0.02] transition-colors">
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1.5">
                          <span className={`px-2 py-0.5 rounded-[8px] border text-[10px] font-700 uppercase tracking-[0.08em] ${badgeClass(task.status)}`}>{task.status}</span>
                          {sourceSchedule && (
                            <span className="text-[11px] text-text-3/60 uppercase tracking-[0.08em]">{sourceSchedule.name}</span>
                          )}
                        </div>
                        <div className="text-[15px] font-600 text-text-2">{task.title}</div>
                        <div className="text-[13px] text-text-3 mt-1 line-clamp-2">{runPreview(task)}</div>
                        <div className="flex flex-wrap items-center gap-2 mt-3">
                          {agent && (
                            <div className="inline-flex items-center gap-2 rounded-[10px] bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-text-2">
                              <AgentAvatar
                                seed={agent.avatarSeed}
                                avatarUrl={agent.avatarUrl}
                                name={agent.name}
                                size={16}
                              />
                              <span>{agent.name}</span>
                            </div>
                          )}
                          <span className="text-[12px] text-text-3/60">Updated {timeAgo(task.updatedAt, now)}</span>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <ActionButton onClick={() => openTask(task.id)}>Open Task</ActionButton>
                        {sourceSchedule && sourceSchedule.status !== 'archived' && (
                          <ActionButton onClick={() => openSchedule(sourceSchedule.id)}>Open Schedule</ActionButton>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="divide-y divide-white/[0.05]">
              {filteredSchedules.length === 0 ? (
                <div className="px-5 py-10 text-center text-text-3/60">
                  {scope === 'archived' ? 'No archived schedules yet.' : 'No schedules match the current filters.'}
                </div>
              ) : filteredSchedules.map((schedule) => {
                const agent = agents[schedule.agentId]
                const isBusy = busyId === schedule.id
                const canToggle = schedule.status === 'active' || schedule.status === 'paused'
                return (
                  <div
                    key={schedule.id}
                    onClick={() => { if (scope === 'live') openSchedule(schedule.id) }}
                    className={`w-full text-left px-5 py-4 hover:bg-white/[0.02] transition-colors ${scope === 'live' ? 'cursor-pointer' : 'cursor-default'}`}
                    style={{ fontFamily: 'inherit' }}
                  >
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1.5">
                          <span className={`px-2 py-0.5 rounded-[8px] border text-[10px] font-700 uppercase tracking-[0.08em] ${badgeClass(schedule.status)}`}>{schedule.status}</span>
                          <span className="text-[11px] text-text-3/60 uppercase tracking-[0.08em]">{schedule.scheduleType}</span>
                          {schedule.lastDeliveryStatus && (
                            <span className={`px-2 py-0.5 rounded-[8px] border text-[10px] font-700 uppercase tracking-[0.08em] ${badgeClass(schedule.lastDeliveryStatus === 'ok' ? 'completed' : 'failed')}`}>
                              {schedule.lastDeliveryStatus === 'ok' ? 'healthy' : 'delivery error'}
                            </span>
                          )}
                        </div>
                        <div className="text-[15px] font-600 text-text-2">{schedule.name}</div>
                        <div className="text-[13px] text-text-3 mt-1">{formatScheduleCadence(schedule)}</div>
                        <div className="text-[13px] text-text-3/80 mt-1 line-clamp-2">{schedule.taskPrompt}</div>
                        <div className="flex flex-wrap items-center gap-2 mt-3">
                          {agent && (
                            <div className="inline-flex items-center gap-2 rounded-[10px] bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-text-2">
                              <AgentAvatar
                                seed={agent.avatarSeed}
                                avatarUrl={agent.avatarUrl}
                                name={agent.name}
                                size={16}
                              />
                              <span>{agent.name}</span>
                            </div>
                          )}
                          <span className="text-[12px] text-text-3/60">{scheduleTimingLabel(schedule, now)}</span>
                          {schedule.lastRunAt && (
                            <span className="text-[12px] text-text-3/50">Last run {timeAgo(schedule.lastRunAt, now)}</span>
                          )}
                        </div>
                      </div>
                      <div
                        className="flex flex-wrap items-center gap-2 shrink-0"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {scope === 'archived' ? (
                          <>
                            <ActionButton disabled={isBusy} onClick={() => handleRestore(schedule.id)}>
                              {isBusy ? 'Restoring...' : 'Restore'}
                            </ActionButton>
                            <ActionButton tone="danger" disabled={isBusy} onClick={() => handlePurge(schedule.id)}>
                              {isBusy ? 'Purging...' : 'Purge'}
                            </ActionButton>
                          </>
                        ) : (
                          <>
                            <ActionButton disabled={isBusy} onClick={() => handleRunNow(schedule.id)}>
                              {isBusy ? 'Queueing...' : 'Run Now'}
                            </ActionButton>
                            {canToggle && (
                              <ActionButton disabled={isBusy} onClick={() => handleToggleStatus(schedule)}>
                                {schedule.status === 'active' ? 'Pause' : 'Resume'}
                              </ActionButton>
                            )}
                            <ActionButton disabled={isBusy} onClick={() => openSchedule(schedule.id)}>Edit</ActionButton>
                            <ActionButton tone="danger" disabled={isBusy} onClick={() => handleArchive(schedule.id)}>
                              {isBusy ? 'Archiving...' : 'Archive'}
                            </ActionButton>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
