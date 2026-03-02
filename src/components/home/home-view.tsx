'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { api } from '@/lib/api-client'
import type { Agent, Session, ActivityEntry, BoardTask, AppNotification } from '@/types'

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function timeUntil(ts: number): string {
  const diff = ts - Date.now()
  if (diff <= 0) return 'now'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `in ${hours}h`
  const days = Math.floor(hours / 24)
  return `in ${days}d`
}

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

export function HomeView() {
  const agents = useAppStore((s) => s.agents)
  const sessions = useAppStore((s) => s.sessions)
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
  const setActiveView = useAppStore((s) => s.setActiveView)
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)
  const setCurrentSession = useAppStore((s) => s.setCurrentSession)
  const setEditingTaskId = useAppStore((s) => s.setEditingTaskId)
  const setTaskSheetOpen = useAppStore((s) => s.setTaskSheetOpen)
  const setMessages = useChatStore((s) => s.setMessages)
  const [todayCost, setTodayCost] = useState(0)

  const allAgents = Object.values(agents).filter((a) => !a.trashedAt)
  const pinnedAgents = allAgents.filter((a) => a.pinned)

  const recentChats = useMemo(
    () =>
      Object.values(sessions)
        .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
        .slice(0, 5),
    [sessions],
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
    const now = Date.now()
    return Object.values(schedules)
      .filter((s) => s.status === 'active' && s.nextRunAt && s.nextRunAt > now)
      .sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0))
      .slice(0, 5)
  }, [schedules])

  // Unread notifications
  const unreadNotifications = useMemo(
    () => notifications.filter((n) => !n.read).slice(0, 5),
    [notifications],
  )

  // Recent activity (last 8)
  const recentActivity = useMemo(() => activityEntries.slice(0, 8), [activityEntries])

  // Load data on mount
  useEffect(() => {
    void loadActivity({ limit: 8 })
    void loadSchedules()
    void loadNotifications()
    void loadConnectors()
    api<{ records: Array<{ estimatedCost: number }> }>('GET', '/usage?range=24h')
      .then((data) => {
        const total = (data.records || []).reduce((s, r) => s + (r.estimatedCost || 0), 0)
        setTodayCost(total)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleAgentClick = (agent: Agent) => {
    setMessages([])
    void setCurrentAgent(agent.id)
    setActiveView('agents')
  }

  const handleChatClick = (session: Session) => {
    setCurrentSession(session.id)
    setActiveView('agents')
  }

  const handleTaskClick = (task: BoardTask) => {
    setEditingTaskId(task.id)
    setTaskSheetOpen(true)
    setActiveView('tasks')
  }

  const handleNotificationClick = (n: AppNotification) => {
    if (!n.read) void markNotificationRead(n.id)
    if (n.entityType === 'agent' && n.entityId) {
      void setCurrentAgent(n.entityId)
      setActiveView('agents')
    } else if (n.entityType === 'task' && n.entityId) {
      setEditingTaskId(n.entityId)
      setTaskSheetOpen(true)
      setActiveView('tasks')
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[800px] mx-auto px-6 py-10">
        {/* Header */}
        <div className="mb-10">
          <h1 className="font-display text-[28px] font-700 text-text tracking-[-0.03em]">
            SwarmClaw
          </h1>
          <p className="text-[14px] text-text-3 mt-1">
            Your AI agent orchestration dashboard
          </p>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10">
          <StatCard label="Agents" value={String(agentCount)} />
          <StatCard label="Active Tasks" value={String(activeTaskCount)} accent={activeTaskCount > 0} />
          <StatCard label="Today's Cost" value={`$${todayCost.toFixed(2)}`} />
          <StatCard label="Connectors" value={`${activeConnectorCount}/${allConnectors.length}`} accent={activeConnectorCount > 0} />
        </div>

        {/* Notifications banner */}
        {unreadNotifications.length > 0 && (
          <section className="mb-8">
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
                    <span className="text-[10px] text-text-3/40 shrink-0 mt-0.5">{timeAgo(n.createdAt)}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Connector Status */}
        <section className="mb-8">
          <SectionHeader label="Connectors" onViewAll={allConnectors.length > 0 ? () => setActiveView('connectors') : undefined} />
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          {/* Running Tasks */}
          <section>
            <SectionHeader label="Running Tasks" onViewAll={runningTasks.length > 0 ? () => setActiveView('tasks') : undefined} />
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
                          {agent?.name || 'Unassigned'} · {task.status === 'running' ? 'running' : 'queued'}{task.startedAt ? ` · ${timeAgo(task.startedAt)}` : ''}
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
            <SectionHeader label="Upcoming Schedules" onViewAll={upcomingSchedules.length > 0 ? () => setActiveView('schedules') : undefined} />
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
                          {agent?.name || 'No agent'} · {sched.nextRunAt ? timeUntil(sched.nextRunAt) : '—'}
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
        <section className="mb-8">
          <SectionHeader label="Pinned Agents" />
          {pinnedAgents.length > 0 ? (
            <div className="flex gap-3 overflow-x-auto pb-2">
              {pinnedAgents.map((agent) => {
                const threadSession = agent.threadSessionId ? sessions[agent.threadSessionId] as Session | undefined : undefined
                const heartbeatOn = agent.heartbeatEnabled === true && (agent.tools?.length ?? 0) > 0
                const recentlyActive = (threadSession?.lastActiveAt ?? 0) > Date.now() - 30 * 60 * 1000
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
                      <AgentAvatar seed={agent.avatarSeed} name={agent.name} size={36} />
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
                        {isOnline ? 'Online' : lastActive ? timeAgo(lastActive) : 'Idle'}
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
        <section className="mb-8">
          <SectionHeader label="Recent Chats" />
          {recentChats.length > 0 ? (
            <div className="flex flex-col gap-1">
              {recentChats.map((session) => {
                const agent = session.agentId ? agents[session.agentId] : null
                const lastMsg = session.messages?.[session.messages.length - 1]
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
                      name={displayName}
                      size={28}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-600 text-text truncate">
                          {displayName}
                        </span>
                        <span className="text-[11px] text-text-3/50 shrink-0">
                          {timeAgo(session.lastActiveAt || session.createdAt)}
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
          <section className="mb-10">
            <SectionHeader label="Recent Activity" />
            <div className="flex flex-col gap-0.5">
              {recentActivity.map((entry) => (
                <div key={entry.id} className="flex items-center gap-2.5 px-3 py-2 rounded-[10px]">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                    className={`shrink-0 ${ACTIVITY_COLORS[entry.action] || 'text-text-3'}`}>
                    <path d={ACTIVITY_ICONS[entry.action] || ACTIVITY_ICONS.updated} />
                  </svg>
                  <span className="text-[12px] text-text-3/80 flex-1 truncate">{entry.summary}</span>
                  <span className="text-[10px] text-text-3/40 shrink-0">{timeAgo(entry.timestamp)}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

function SectionHeader({ label, onViewAll }: { label: string; onViewAll?: () => void }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="font-display text-[13px] font-600 text-text-2 uppercase tracking-[0.08em]">
        {label}
      </h2>
      {onViewAll && (
        <button
          onClick={onViewAll}
          className="text-[11px] text-text-3/50 hover:text-text-3 transition-colors bg-transparent border-none cursor-pointer"
          style={{ fontFamily: 'inherit' }}
        >
          View all →
        </button>
      )}
    </div>
  )
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="px-4 py-3 rounded-[12px] bg-white/[0.03] border border-white/[0.06]">
      <p className="text-[11px] font-600 text-text-3/60 uppercase tracking-wider mb-1">{label}</p>
      <p className={`font-display text-[20px] font-700 tracking-[-0.02em] ${accent ? 'text-accent-bright' : 'text-text'}`}>{value}</p>
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
