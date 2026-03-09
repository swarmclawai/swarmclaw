'use client'

import { memo, useCallback, useState } from 'react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { useAppStore } from '@/stores/use-app-store'

// ---------------------------------------------------------------------------
// Types (mirror server-side SwarmSnapshot for the UI)
// ---------------------------------------------------------------------------

type MemberStatus = 'initializing' | 'ready' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'spawn_error'
type SwarmStatus = 'spawning' | 'running' | 'completed' | 'partial' | 'failed'

export interface SwarmMemberData {
  index: number
  agentId: string
  agentName: string
  jobId: string
  sessionId: string
  task: string
  status: MemberStatus
  resultPreview: string | null
  error: string | null
  durationMs: number
}

export interface SwarmStatusData {
  swarmId: string
  parentSessionId: string | null
  parentAgentName: string
  parentAgentSeed: string | null
  parentAgentAvatarUrl?: string | null
  status: SwarmStatus
  createdAt: number
  completedAt: number | null
  memberCount: number
  completedCount: number
  failedCount: number
  members: SwarmMemberData[]
}

// ---------------------------------------------------------------------------
// Status config
// ---------------------------------------------------------------------------

const SWARM_STATUS_CONFIG: Record<SwarmStatus, { label: string; color: string; bg: string; border: string }> = {
  spawning: { label: 'Spawning', color: '#818CF8', bg: 'rgba(99,102,241,0.06)', border: 'rgba(99,102,241,0.12)' },
  running:  { label: 'Running',  color: '#818CF8', bg: 'rgba(99,102,241,0.06)', border: 'rgba(99,102,241,0.12)' },
  completed:{ label: 'All completed', color: '#34D399', bg: 'rgba(52,211,153,0.05)', border: 'rgba(52,211,153,0.12)' },
  partial:  { label: 'Partial',  color: '#FBBF24', bg: 'rgba(251,191,36,0.05)', border: 'rgba(251,191,36,0.12)' },
  failed:   { label: 'Failed',   color: '#F43F5E', bg: 'rgba(244,63,94,0.05)', border: 'rgba(244,63,94,0.12)' },
}

const MEMBER_STATUS_CONFIG: Record<MemberStatus, { label: string; color: string; dotColor: string }> = {
  initializing: { label: 'Initializing', color: '#A78BFA', dotColor: '#A78BFA' },
  ready:        { label: 'Queued',        color: '#818CF8', dotColor: '#818CF8' },
  running:      { label: 'Running',       color: '#60A5FA', dotColor: '#60A5FA' },
  waiting:      { label: 'Waiting',       color: '#818CF8', dotColor: '#818CF8' },
  completed:    { label: 'Completed',     color: '#34D399', dotColor: '#34D399' },
  failed:       { label: 'Failed',        color: '#F43F5E', dotColor: '#F43F5E' },
  cancelled:    { label: 'Cancelled',     color: '#6B7280', dotColor: '#6B7280' },
  timed_out:    { label: 'Timed out',     color: '#F59E0B', dotColor: '#F59E0B' },
  spawn_error:  { label: 'Spawn failed',  color: '#F43F5E', dotColor: '#F43F5E' },
}

// ---------------------------------------------------------------------------
// Swarm icon
// ---------------------------------------------------------------------------

function SwarmIcon({ size = 16, color = '#818CF8' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="shrink-0">
      {/* Center bee */}
      <circle cx="12" cy="12" r="2.5" fill={color} opacity="0.9" />
      {/* Orbital bees */}
      <circle cx="6" cy="8" r="1.5" fill={color} opacity="0.6" />
      <circle cx="18" cy="8" r="1.5" fill={color} opacity="0.6" />
      <circle cx="6" cy="16" r="1.5" fill={color} opacity="0.6" />
      <circle cx="18" cy="16" r="1.5" fill={color} opacity="0.6" />
      {/* Connection lines */}
      <line x1="8" y1="9" x2="10" y2="11" stroke={color} strokeWidth="0.8" opacity="0.3" />
      <line x1="16" y1="9" x2="14" y2="11" stroke={color} strokeWidth="0.8" opacity="0.3" />
      <line x1="8" y1="15" x2="10" y2="13" stroke={color} strokeWidth="0.8" opacity="0.3" />
      <line x1="16" y1="15" x2="14" y2="13" stroke={color} strokeWidth="0.8" opacity="0.3" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Member status dot
// ---------------------------------------------------------------------------

function StatusDot({ status }: { status: MemberStatus }) {
  const cfg = MEMBER_STATUS_CONFIG[status]
  const isActive = status === 'running' || status === 'initializing' || status === 'waiting'
  return (
    <span
      className="shrink-0 rounded-full"
      style={{
        width: 7,
        height: 7,
        backgroundColor: cfg.dotColor,
        ...(isActive ? { animation: 'swarm-pulse 1.5s ease-in-out infinite' } : {}),
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Member card
// ---------------------------------------------------------------------------

const SwarmMemberCard = memo(function SwarmMemberCard({
  member,
  agents,
}: {
  member: SwarmMemberData
  agents: Record<string, any>
}) {
  const [expanded, setExpanded] = useState(false)
  const cfg = MEMBER_STATUS_CONFIG[member.status]
  const agent = agents[member.agentId]
  const avatarSeed = agent?.avatarSeed || member.agentId
  const avatarUrl = agent?.avatarUrl || null
  const hasContent = !!(member.resultPreview || member.error)

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  return (
    <div
      className="rounded-[10px] overflow-hidden transition-all"
      style={{
        background: 'rgba(255,255,255,0.015)',
        border: `1px solid rgba(255,255,255,0.05)`,
        animation: `swarm-member-in 0.35s cubic-bezier(0.16, 1, 0.3, 1) ${member.index * 80}ms both`,
      }}
    >
      {/* Header */}
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 bg-transparent border-none cursor-pointer text-left"
        onClick={() => hasContent && setExpanded(!expanded)}
        disabled={!hasContent}
      >
        <AgentAvatar seed={avatarSeed} avatarUrl={avatarUrl} name={member.agentName} size={20} />
        <StatusDot status={member.status} />
        <div className="flex flex-col gap-0 min-w-0 flex-1">
          <span className="text-[11px] font-600 text-text-2 truncate">
            {member.agentName}
          </span>
          <span className="text-[10px] truncate" style={{ color: cfg.color }}>
            {cfg.label}
            {member.durationMs > 0 && member.status !== 'running' && (
              <span className="text-text-3/50 ml-1">
                {formatDuration(member.durationMs)}
              </span>
            )}
          </span>
        </div>
        {hasContent && (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="shrink-0 text-text-3/30 transition-transform"
            style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {/* Expanded content */}
      {expanded && hasContent && (
        <div
          className="px-3 pb-2.5 pt-0"
          style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
        >
          {member.error && (
            <div className="text-[11px] text-rose-400/80 leading-relaxed break-words mt-1.5">
              {member.error}
            </div>
          )}
          {member.resultPreview && !member.error && (
            <div className="text-[11px] text-text-3/70 leading-relaxed break-words mt-1.5 max-h-[120px] overflow-y-auto">
              {member.resultPreview}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Aggregate summary bar
// ---------------------------------------------------------------------------

function SwarmSummaryBar({ data }: { data: SwarmStatusData }) {
  const cfg = SWARM_STATUS_CONFIG[data.status]
  const isTerminal = data.status === 'completed' || data.status === 'partial' || data.status === 'failed'

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
    return `${(ms / 60_000).toFixed(1)}m`
  }

  const durationMs = data.completedAt
    ? data.completedAt - data.createdAt
    : Date.now() - data.createdAt

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-[8px]"
      style={{ background: `${cfg.color}08` }}
    >
      <span className="text-[11px] font-700" style={{ color: cfg.color }}>
        {data.completedCount}/{data.memberCount} completed
      </span>
      {data.failedCount > 0 && (
        <span className="text-[11px] font-600 text-rose-400/70">
          {data.failedCount} failed
        </span>
      )}
      {isTerminal && (
        <span className="text-[10px] text-text-3/40 ml-auto">
          {formatDuration(durationMs)}
        </span>
      )}
      {!isTerminal && (
        <span
          className="text-[10px] ml-auto"
          style={{ color: cfg.color, opacity: 0.6 }}
        >
          in progress...
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const SwarmStatusCard = memo(function SwarmStatusCard({
  data,
}: {
  data: SwarmStatusData
}) {
  const cfg = SWARM_STATUS_CONFIG[data.status]
  const agents = useAppStore((s) => s.agents || {})
  const isActive = data.status === 'spawning' || data.status === 'running'

  return (
    <div
      className="rounded-[14px] overflow-hidden"
      style={{
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        animation: 'delegation-handoff-in 0.45s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2.5 px-4 py-3"
        style={{
          borderBottom: `1px solid ${cfg.border}`,
        }}
      >
        <SwarmIcon size={18} color={cfg.color} />
        <div className="shrink-0">
          <AgentAvatar
            seed={data.parentAgentSeed}
            avatarUrl={data.parentAgentAvatarUrl}
            name={data.parentAgentName}
            size={22}
          />
        </div>
        <div className="flex flex-col gap-0 min-w-0 flex-1">
          <span className="text-[12px] font-700" style={{ color: cfg.color }}>
            Swarm spawned by {data.parentAgentName}
          </span>
          <span className="text-[10px] text-text-3/50">
            {data.memberCount} agent{data.memberCount !== 1 ? 's' : ''}
            {' · '}
            {new Date(data.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
        {isActive && (
          <span
            className="shrink-0 w-2 h-2 rounded-full"
            style={{
              backgroundColor: cfg.color,
              animation: 'swarm-pulse 1.5s ease-in-out infinite',
            }}
          />
        )}
      </div>

      {/* Members grid */}
      <div className="px-3 py-2.5 flex flex-col gap-1.5">
        {data.members.map((member) => (
          <SwarmMemberCard
            key={member.index}
            member={member}
            agents={agents}
          />
        ))}
      </div>

      {/* Summary bar */}
      <div className="px-3 pb-3">
        <SwarmSummaryBar data={data} />
      </div>
    </div>
  )
})

// ---------------------------------------------------------------------------
// CSS keyframes (inject once)
// ---------------------------------------------------------------------------

const SWARM_STYLES = `
@keyframes swarm-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.85); }
}
@keyframes swarm-member-in {
  from { opacity: 0; transform: translateY(6px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
`

/** Call this once in a layout or the component tree root */
export function SwarmStatusStyles() {
  return <style dangerouslySetInnerHTML={{ __html: SWARM_STYLES }} />
}
