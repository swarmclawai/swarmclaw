'use client'

import { useEffect, useMemo, useState } from 'react'
import { AreaChart, Area, ResponsiveContainer, Tooltip } from 'recharts'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { useMountedRef } from '@/hooks/use-mounted-ref'
import { useNow } from '@/hooks/use-now'
import { api } from '@/lib/app/api-client'
import { useNavigate } from '@/lib/app/navigation'
import { isLocalhostBrowser, isVisibleSessionForViewer } from '@/lib/observability/local-observability'
import { getSessionLastMessage } from '@/lib/chat/session-summary'
import { getNotificationActivityAt, getNotificationOccurrenceCount } from '@/lib/notifications/notification-utils'
import { timeAgo, timeUntil } from '@/lib/time-format'
import type { Agent, Session, ActivityEntry, BoardTask, AppNotification } from '@/types'
import { HintTip } from '@/components/shared/hint-tip'
import { MainContent } from '@/components/layout/main-content'
import { PageLoader } from '@/components/ui/page-loader'
import { SectionHeader } from '@/components/ui/section-header'
import { StatCard } from '@/components/ui/stat-card'

const ACTIVITY_ICONS: Record<ActivityEntry['action'], string> = {
  created: 'M12 5v14m-7-7h14',
  updated: 'M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z',
  deleted: 'M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  started: 'M5 3l14 9-14 9V3z',
  stopped: 'M6 4h4v16H6zm8 0h4v16h-4z',
  queued: 'M12 6v6l4 2',
  completed: 'M20 6L9 17l-5-5',
  failed: 'M18 6L6 18M6 6l12 12',
  approved: 'M22 11.08V12a10 10 0 1 1-5.93-9.14',
  rejected: 'M10 15l5-5m0 5l-5-5',
}

const ACTIVITY_COLORS: Record<ActivityEntry['action'], string> = {
  created: 'text-emerald-400',
  updated: 'text-sky-400',
  deleted: 'text-red-400',
  started: 'text-emerald-400',
  stopped: 'text-text-3',
  queued: 'text-amber-400',
  completed: 'text-emerald-400',
  failed: 'text-red-400',
  approved: 'text-emerald-400',
  rejected: 'text-red-400',
}

const PLATFORM_LABELS: Record<string, string> = {
  discord: 'Discord',
  telegram: 'Telegram',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
  openclaw: 'OpenClaw',
}

export default function HomePage() {
  const now = useNow()
  const agents = useAppStore((s) => s.agents)
  const sessions = useAppStore((s) => s.sessions)
  const currentUser = useAppStore((s) => s.currentUser)
  const tasks = useAppStore((s) => s.tasks)
  const connectors = useAppStore((s) => s.connectors)
  const schedules = useAppStore((s) => s.schedules)
  const activityEntries = useAppStore((s) => s.activityEntries)
  const notifications = useAppStore((s) => s.notifications)
  const unreadNotificationCount = useAppStore((s) => s.unreadNotificationCount)
  const streamingSessionId = useChatStore((s) => s.streamingSessionId)
  const loadActivity = useAppStore((s) => s.loadActivity)
  const loadSchedules = useAppStore((s) => s.loadSchedules)
  const loadNotifications = useAppStore((s) => s.loadNotifications)
  const loadConnectors = useAppStore((s) => s.loadConnectors)
  const markNotificationRead = useAppStore((s) => s.markNotificationRead)
  const navigateTo = useNavigate()
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)
  const setEditingTaskId = useAppStore((s) => s.setEditingTaskId)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)
  const [todayCost, setTodayCost] = useState(0)
  const [costTrend, setCostTrend] = useState<{ cost: number; bucket: string }[]>([])
  const [localhostBrowser, setLocalhostBrowser] = useState(false)
  const [pageReady, setPageReady] = useState(false)
  const mountedRef = useMountedRef()

  useEffect(() => {
    setLocalhostBrowser(isLocalhostBrowser())
  }, [])

  const allAgents = Object.values(agents).filter((a) => !a.trashedAt)
  const pinnedAgents = allAgents.filter((a) => a.pinned)

  const recentChats = useMemo(
    () =>
      Object.values(sessions)
        .filter((session) => isVisibleSessionForViewer(session, currentUser, { localhost: localhostBrowser }))
        .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
        .slice(0, 5),
    [currentUser, localhostBrowser, sessions],
  )

  // Quick stats
  const agentCount = allAgents.length
  const allTasks = Object.values(tasks)
  const activeTaskCount = allTasks.filter((t) => t.status === 'running' || t.status === 'queued').length
  const allConnectors = Object.values(connectors)
  const activeConnectorCount = allConnectors.filter((c) => c.status === 'running').length

  // Agents with running tasks
  const runningAgentIds = useMemo(() => {
    const set = new Set<string>()
    for (const task of allTasks) {
      if (task.status === 'running' && task.agentId) set.add(task.agentId)
    }
    return set
  }, [allTasks])

  // Running tasks for the running tasks section
  const runningTasks = useMemo(
    () => allTasks.filter((t) => t.status === 'running' || t.status === 'queued').slice(0, 5),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks],
  )

  // Upcoming schedules
  const upcomingSchedules = useMemo(() => {
    const currentNow = now ?? 0
    return Object.values(schedules)
      .filter((s) => s.status === 'active' && s.nextRunAt && s.nextRunAt > currentNow)
      .sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0))
      .slice(0, 5)
  }, [now, schedules])

  // Unread notifications
  const unreadNotifications = useMemo(
    () => notifications.filter((n) => !n.read).slice(0, 5),
    [notifications],
  )

  // Recent activity (last 8)
  const recentActivity = useMemo(() => activityEntries.slice(0, 8), [activityEntries])

  // Load data on mount
  useEffect(() => {
    let cancelled = false
    void loadActivity({ limit: 8 })
    void loadSchedules()
    void loadNotifications()
    const connectorTimer = window.setTimeout(() => {
      if (!cancelled) void loadConnectors()
    }, 1200)
    api<{ records: Array<{ estimatedCost: number }>; timeSeries: Array<{ cost: number; bucket: string }> }>('GET', '/usage?range=7d')
      .then((data) => {
        if (cancelled || !mountedRef.current) return
        const series = (data.timeSeries || []).map((pt: { cost: number; bucket?: string }) => ({ cost: pt.cost, bucket: pt.bucket || '' }))
        setCostTrend(series)
        const todayBucket = new Date().toISOString().slice(0, 10)
        const todayPt = series.find((pt) => pt.bucket === todayBucket)
        setTodayCost(todayPt?.cost || 0)
      })
      .catch(() => {})
      .finally(() => { if (!cancelled && mountedRef.current) setPageReady(true) })
    return () => {
      cancelled = true
      window.clearTimeout(connectorTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountedRef])

  const handleAgentClick = (agent: Agent) => {
    navigateTo('agents', agent.id)
  }

  const handleChatClick = (session: Session) => {
    if (session.agentId) void setCurrentAgent(session.agentId)
    navigateTo('agents')
  }

  const handleTaskClick = (task: BoardTask) => {
    setEditingTaskId(task.id)
    setTaskSheetOpen(true)
    navigateTo('tasks')
  }

  const handleNotificationClick = (n: AppNotification) => {
    if (!n.read) void markNotificationRead(n.id)
    if (n.entityType === 'agent' && n.entityId) {
      navigateTo('agents', n.entityId)
    } else if (n.entityType === 'task' && n.entityId) {
      setEditingTaskId(n.entityId)
      setTaskSheetOpen(true)
      navigateTo('tasks')
    }
  }

  if (!pageReady) {
    return (
      <MainContent>
        <PageLoader label="Loading dashboard..." />
      </MainContent>
    )
  }

  return (
    <MainContent>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[800px] mx-auto px-6 py-10">
          {/* Header */}
          <div className="mb-10" style={{ animation: 'spring-in 0.6s var(--ease-spring)' }}>
            <h1 className="font-display text-[28px] font-700 text-text tracking-[-0.03em]">
              SwarmClaw
            </h1>
            <p className="text-[14px] text-text-3 mt-1">
              Workspace overview for your agent chats, tasks, and automations
            </p>
          </div>

          {/* Quick actions / triage */}
          <section className="mb-8" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.15s both' }}>
            <SectionHeader
              label="Needs Attention"
              action={activeTaskCount > 0 ? { label: 'Open Tasks', onClick: () => navigateTo('tasks') } : undefined}
            />
            <div className="rounded-[18px] border border-white/[0.06] bg-white/[0.025] p-4">
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <StatusPill label={`${allTasks.filter((task) => task.status === 'failed').length} failed task${allTasks.filter((task) => task.status === 'failed').length === 1 ? '' : 's'}`} tone={allTasks.some((task) => task.status === 'failed') ? 'danger' : 'neutral'} />
                <StatusPill label={`${allTasks.filter((task) => (task.blockedBy?.length || 0) > 0).length} blocked task${allTasks.filter((task) => (task.blockedBy?.length || 0) > 0).length === 1 ? '' : 's'}`} tone={allTasks.some((task) => (task.blockedBy?.length || 0) > 0) ? 'warning' : 'neutral'} />
                <StatusPill label={`${allConnectors.filter((connector) => connector.status === 'error').length} connector issue${allConnectors.filter((connector) => connector.status === 'error').length === 1 ? '' : 's'}`} tone={allConnectors.some((connector) => connector.status === 'error') ? 'danger' : 'neutral'} />
                <StatusPill label={`${runningAgentIds.size} active agent${runningAgentIds.size === 1 ? '' : 's'}`} tone={runningAgentIds.size > 0 ? 'success' : 'neutral'} />
              </div>

              {(() => {
                const currentNow = now ?? 0
                const items = [
                  ...allTasks
                    .filter((task) => (task.blockedBy?.length || 0) > 0)
                    .slice(0, 2)
                    .map((task) => ({
                      id: `blocked:${task.id}`,
                      tone: 'warning' as const,
                      label: task.title,
                      meta: `${task.agentId && agents[task.agentId] ? agents[task.agentId]!.name : 'Task'} is blocked by dependencies`,
                      onClick: () => handleTaskClick(task),
                    })),
                  ...allTasks
                    .filter((task) => task.status === 'failed')
                    .slice(0, 2)
                    .map((task) => ({
                      id: `failed:${task.id}`,
                      tone: 'danger' as const,
                      label: task.title,
                      meta: `Failed ${timeAgo(task.updatedAt || task.createdAt, now)}`,
                      onClick: () => handleTaskClick(task),
                    })),
                  ...allConnectors
                    .filter((connector) => connector.status === 'error')
                    .slice(0, 2)
                    .map((connector) => ({
                      id: `connector:${connector.id}`,
                      tone: 'danger' as const,
                      label: connector.name,
                      meta: `${PLATFORM_LABELS[connector.platform] || connector.platform} connector needs attention`,
                      onClick: () => navigateTo('connectors'),
                    })),
                  ...Object.values(schedules)
                    .filter((schedule) => schedule.status === 'active' && schedule.nextRunAt && schedule.nextRunAt < currentNow)
                    .slice(0, 2)
                    .map((schedule) => ({
                      id: `schedule:${schedule.id}`,
                      tone: 'warning' as const,
                      label: schedule.name,
                      meta: 'Schedule missed its expected run window',
                      onClick: () => navigateTo('schedules'),
                    })),
                  ...unreadNotifications
                    .slice(0, 2)
                    .map((notification) => ({
                      id: `notification:${notification.id}`,
                      tone: 'info' as const,
                      label: notification.title,
                      meta: notification.message || 'Unread notification',
                      onClick: () => handleNotificationClick(notification),
                    })),
                ].slice(0, 6)

                if (items.length === 0) {
                  return (
                    <div className="rounded-[14px] border border-dashed border-white/[0.06] bg-white/[0.02] px-4 py-5">
                      <p className="text-[13px] font-600 text-text">Everything looks stable.</p>
                      <p className="text-[12px] text-text-3/60 mt-1">
                        No failed tasks, no blocked tasks, and no connector issues right now.
                      </p>
                    </div>
                  )
                }

                return (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {items.map((item) => (
                      <button
                        key={item.id}
                        onClick={item.onClick}
                        className="flex items-start gap-3 rounded-[14px] border border-white/[0.06] bg-transparent px-4 py-3 text-left hover:bg-white/[0.04] transition-colors cursor-pointer"
                        style={{ fontFamily: 'inherit' }}
                      >
                        <div className={`mt-0.5 h-2.5 w-2.5 rounded-full shrink-0 ${
                          item.tone === 'danger'
                            ? 'bg-red-400'
                            : item.tone === 'warning'
                              ? 'bg-amber-400'
                              : 'bg-sky-400'
                        }`} />
                        <div className="min-w-0">
                          <div className="text-[13px] font-600 text-text truncate">{item.label}</div>
                          <div className="text-[11px] text-text-3/65 mt-1">{item.meta}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )
              })()}
            </div>
          </section>

          {/* Quick Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
            <StatCard label="Agents" value={String(agentCount)} hint="Total active agents configured in your dashboard" index={0} />
            <StatCard label="Active Tasks" value={String(activeTaskCount)} accent={activeTaskCount > 0} hint="Tasks currently running or queued for execution" index={1} />
            <StatCard label="Today's Cost" value={`$${todayCost.toFixed(2)}`} hint="Estimated API cost for today across all providers" index={2} />
            <StatCard label="Connectors" value={`${activeConnectorCount}/${allConnectors.length}`} accent={activeConnectorCount > 0} hint="Active bridges to chat platforms (Discord, Slack, etc.)" index={3} />
          </div>

          {/* Cost trend sparkline */}
          {costTrend.length > 1 && (
            <div className="mb-10 px-1" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.3s both' }}>
              <p className="text-[10px] text-text-3/50 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                7-day cost trend <HintTip text="Daily API spend over the past week — hover for details" />
              </p>
              <ResponsiveContainer width="100%" height={60}>
                <AreaChart data={costTrend} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} style={{ cursor: 'crosshair' }}>
                  <defs>
                    <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#818CF8" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#818CF8" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.[0]) return null
                      const d = payload[0].payload as { cost: number; bucket: string }
                      const label = d.bucket
                        ? new Date(d.bucket + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
                        : ''
                      return (
                        <div className="rounded-[8px] bg-surface border border-white/[0.1] px-3 py-2 shadow-lg">
                          <p className="text-[11px] text-text-3/70 m-0">{label}</p>
                          <p className="text-[14px] font-600 text-text m-0 mt-0.5">${d.cost.toFixed(4)}</p>
                        </div>
                      )
                    }}
                    cursor={{ stroke: '#818CF8', strokeWidth: 1, strokeDasharray: '3 3' }}
                  />
                  <Area type="monotone" dataKey="cost" stroke="#818CF8" strokeWidth={1.5} fill="url(#costGrad)" dot={false} activeDot={{ r: 3, fill: '#818CF8', stroke: '#818CF8' }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Notifications banner */}
          {unreadNotifications.length > 0 && (
            <section className="mb-8" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.35s both' }}>
              <div className="rounded-[14px] border border-amber-400/20 bg-amber-400/[0.04] overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-amber-400/10">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-amber-400">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                  <span className="text-[12px] font-600 text-amber-400">
                    {unreadNotificationCount} unread notification{unreadNotificationCount !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="flex flex-col">
                  {unreadNotifications.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => handleNotificationClick(n)}
                      className="flex items-start gap-3 px-4 py-2.5 text-left bg-transparent border-none cursor-pointer
                        hover:bg-white/[0.03] transition-colors w-full"
                      style={{ fontFamily: 'inherit' }}
                    >
                      <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                        n.type === 'error' ? 'bg-red-400' : n.type === 'warning' ? 'bg-amber-400' : n.type === 'success' ? 'bg-emerald-400' : 'bg-sky-400'
                      }`} />
                      <div className="flex-1 min-w-0">
                        <span className="text-[13px] font-500 text-text">{n.title}</span>
                        {n.message && <p className="text-[11px] text-text-3/60 truncate mt-0.5 m-0">{n.message}</p>}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                        {getNotificationOccurrenceCount(n) > 1 && (
                          <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-600 text-text-3/80">
                            x{getNotificationOccurrenceCount(n)}
                          </span>
                        )}
                        <span className="text-[10px] text-text-3/40">{timeAgo(getNotificationActivityAt(n), now)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* Connector Status */}
          <section className="mb-8" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.4s both' }}>
            <SectionHeader label="Connectors" action={allConnectors.length > 0 ? { label: 'View all \u2192', onClick: () => navigateTo('connectors') } : undefined} />
            {allConnectors.length > 0 ? (
              <div className="flex gap-2 flex-wrap">
                {allConnectors.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-2 px-3 py-2 rounded-[10px] bg-white/[0.03] border border-white/[0.06]"
                  >
                    <div className={`w-2 h-2 rounded-full ${
                      c.status === 'running' ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.4)]'
                        : c.status === 'error' ? 'bg-red-400' : 'bg-text-3/30'
                    }`} />
                    <span className="text-[12px] font-500 text-text">{c.name}</span>
                    <span className="text-[10px] text-text-3/50">{PLATFORM_LABELS[c.platform] || c.platform}</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptySection text="No connectors configured — bridge agents to Discord, Slack, Telegram, or WhatsApp" />
            )}
          </section>

          {/* Two-column layout: Running Tasks + Upcoming Schedules */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.45s both' }}>
            {/* Running Tasks */}
            <section>
              <SectionHeader label="Running Tasks" action={runningTasks.length > 0 ? { label: 'View all \u2192', onClick: () => navigateTo('tasks') } : undefined} />
              {runningTasks.length > 0 ? (
                <div className="flex flex-col gap-1">
                  {runningTasks.map((task) => {
                    const agent = task.agentId ? agents[task.agentId] : null
                    return (
                      <button
                        key={task.id}
                        onClick={() => handleTaskClick(task)}
                        className="flex items-center gap-2.5 px-3 py-2.5 rounded-[10px] bg-transparent border-none
                          hover:bg-white/[0.04] transition-colors cursor-pointer w-full text-left"
                        style={{ fontFamily: 'inherit' }}
                      >
                        <div className={`w-2 h-2 rounded-full shrink-0 ${
                          task.status === 'running' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'
                        }`} />
                        <div className="flex-1 min-w-0">
                          <span className="text-[13px] font-500 text-text truncate block">{task.title}</span>
                          <span className="text-[11px] text-text-3/50">
                            {agent?.name || 'Unassigned'} · {task.status === 'running' ? 'running' : 'queued'}{task.startedAt ? ` · ${timeAgo(task.startedAt, now)}` : ''}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="py-4 px-3 text-[12px] text-text-3/40">No tasks running</div>
              )}
            </section>

            {/* Upcoming Schedules */}
            <section>
              <SectionHeader label="Upcoming Schedules" action={upcomingSchedules.length > 0 ? { label: 'View all \u2192', onClick: () => navigateTo('schedules') } : undefined} />
              {upcomingSchedules.length > 0 ? (
                <div className="flex flex-col gap-1">
                  {upcomingSchedules.map((sched) => {
                    const agent = sched.agentId ? agents[sched.agentId] : null
                    return (
                      <div
                        key={sched.id}
                        className="flex items-center gap-2.5 px-3 py-2.5 rounded-[10px]"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/50 shrink-0">
                          <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
                        </svg>
                        <div className="flex-1 min-w-0">
                          <span className="text-[13px] font-500 text-text truncate block">{sched.name}</span>
                          <span className="text-[11px] text-text-3/50">
                            {agent?.name || 'No agent'} · {sched.nextRunAt ? timeUntil(sched.nextRunAt, now) : '—'}
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="py-4 px-3 text-[12px] text-text-3/40">No upcoming schedules</div>
              )}
            </section>
          </div>

          {/* Pinned Agents */}
          <section className="mb-8" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.5s both' }}>
            <SectionHeader label="Pinned Agents" />
            {pinnedAgents.length > 0 ? (
              <div className="flex gap-3 overflow-x-auto pb-2">
                {pinnedAgents.map((agent) => {
                  const threadSession = agent.threadSessionId ? sessions[agent.threadSessionId] as Session | undefined : undefined
                  const heartbeatOn = agent.heartbeatEnabled === true && (agent.plugins?.length ?? 0) > 0
                  const recentlyActive = !!now && (threadSession?.lastActiveAt ?? 0) > now - 30 * 60 * 1000
                  const isOnline = runningAgentIds.has(agent.id) || (threadSession?.active ?? false) || heartbeatOn || recentlyActive
                  const isTyping = streamingSessionId === agent.threadSessionId
                  const lastActive = threadSession?.lastActiveAt || agent.lastUsedAt || agent.updatedAt
                  const modelLabel = agent.model ? agent.model.split('/').pop()?.split(':')[0] : agent.provider

                  return (
                    <button
                      key={agent.id}
                      onClick={() => handleAgentClick(agent)}
                      className="flex flex-col items-center gap-1.5 px-4 py-3.5 rounded-[14px] bg-white/[0.03] border border-white/[0.06]
                        hover:bg-white/[0.06] hover:border-white/[0.1] transition-all cursor-pointer min-w-[130px] shrink-0"
                      style={{ fontFamily: 'inherit' }}
                    >
                      <div className="relative">
                        <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={36} />
                        <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-surface ${
                          isTyping ? 'bg-accent-bright animate-pulse'
                            : isOnline ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.4)]'
                            : 'bg-text-3/30'
                        }`} />
                      </div>
                      <span className="font-display text-[13px] font-600 text-text truncate max-w-[110px]">
                        {agent.name}
                      </span>
                      {isTyping ? (
                        <span className="text-[10px] text-accent-bright/70 flex items-center gap-1">
                          <span className="flex gap-0.5">
                            <span className="w-1 h-1 rounded-full bg-accent-bright/70 animate-bounce [animation-delay:0ms]" />
                            <span className="w-1 h-1 rounded-full bg-accent-bright/70 animate-bounce [animation-delay:150ms]" />
                            <span className="w-1 h-1 rounded-full bg-accent-bright/70 animate-bounce [animation-delay:300ms]" />
                          </span>
                          typing
                        </span>
                      ) : (
                        <span className={`text-[10px] ${isOnline ? 'text-emerald-400/80' : 'text-text-3/50'}`}>
                          {isOnline ? 'Online' : lastActive ? timeAgo(lastActive, now) : 'Idle'}
                        </span>
                      )}
                      {modelLabel && (
                        <span className="text-[9px] text-text-3/40 font-mono truncate max-w-[110px]">
                          {modelLabel}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="py-6 px-4 rounded-[14px] bg-white/[0.02] border border-dashed border-white/[0.06] text-center">
                <p className="text-[13px] text-text-3/60">
                  Star agents from the chat list for quick access
                </p>
              </div>
            )}
          </section>

          {/* Recent Chats */}
          <section className="mb-8" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.55s both' }}>
            <SectionHeader label="Recent Chats" />
            {recentChats.length > 0 ? (
              <div className="flex flex-col gap-1">
                {recentChats.map((session) => {
                  const agent = session.agentId ? agents[session.agentId] : null
                  const lastMsg = getSessionLastMessage(session)
                  const displayName = agent?.name || 'Chat'
                  return (
                    <button
                      key={session.id}
                      onClick={() => handleChatClick(session)}
                      className="flex items-center gap-3 px-4 py-3 rounded-[12px] bg-transparent border-none
                        hover:bg-white/[0.04] transition-all cursor-pointer w-full text-left"
                      style={{ fontFamily: 'inherit' }}
                    >
                      <AgentAvatar
                        seed={agent?.avatarSeed}
                        avatarUrl={agent?.avatarUrl}
                        name={displayName}
                        size={28}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-600 text-text truncate">
                            {displayName}
                          </span>
                          <span className="text-[11px] text-text-3/50 shrink-0">
                            {timeAgo(session.lastActiveAt || session.createdAt, now)}
                          </span>
                        </div>
                        {lastMsg && (
                          <p className="text-[12px] text-text-3/60 truncate mt-0.5 m-0">
                            {lastMsg.text.slice(0, 80)}
                          </p>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            ) : (
              <EmptySection text="No chats yet — start by clicking an agent" />
            )}
          </section>

          {/* Activity Feed */}
          {recentActivity.length > 0 && (
            <section className="mb-10" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.6s both' }}>
              <SectionHeader label="Recent Activity" />
              <div className="flex flex-col gap-0.5">
                {recentActivity.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-2.5 px-3 py-2 rounded-[10px]">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                      className={`shrink-0 ${ACTIVITY_COLORS[entry.action] || 'text-text-3'}`}>
                      <path d={ACTIVITY_ICONS[entry.action] || ACTIVITY_ICONS.updated} />
                    </svg>
                    <span className="text-[12px] text-text-3/80 flex-1 truncate">{entry.summary}</span>
                    <span className="text-[10px] text-text-3/40 shrink-0">{timeAgo(entry.timestamp, now)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </MainContent>
  )
}


function StatusPill({ label, tone }: { label: string; tone: 'neutral' | 'warning' | 'danger' | 'success' }) {
  const toneClasses = tone === 'danger'
    ? 'border-red-400/20 bg-red-400/[0.05] text-red-300/85'
    : tone === 'warning'
      ? 'border-amber-400/20 bg-amber-400/[0.05] text-amber-300/85'
      : tone === 'success'
        ? 'border-emerald-400/20 bg-emerald-400/[0.05] text-emerald-300/85'
        : 'border-white/[0.06] bg-white/[0.03] text-text-3/75'

  return (
    <div className={`rounded-[999px] border px-3 py-1.5 text-[11px] font-600 ${toneClasses}`}>
      {label}
    </div>
  )
}


function EmptySection({ text }: { text: string }) {
  return (
    <div className="py-6 px-4 rounded-[14px] bg-white/[0.02] border border-dashed border-white/[0.06] text-center">
      <p className="text-[13px] text-text-3/60">{text}</p>
    </div>
  )
}
