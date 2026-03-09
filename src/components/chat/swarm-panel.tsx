'use client'

import { useState, useMemo } from 'react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SwarmAgent {
  jobId: string
  agentId?: string
  agentName: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'
  response?: string | null
  error?: string | null
  durationMs?: number
  lineageId?: string
  depth?: number
}

interface SwarmPanelData {
  /** 'batch' for multi-spawn, 'single' for individual spawn results */
  kind: 'batch' | 'single'
  /** Overall status */
  status: 'running' | 'completed' | 'partial' | 'failed'
  /** Individual agent entries */
  agents: SwarmAgent[]
  /** Summary counts (batch only) */
  completed?: number
  failed?: number
  cancelled?: number
  timedOut?: number
  totalDurationMs?: number
  /** Job IDs for polling */
  jobIds?: string[]
}

// ---------------------------------------------------------------------------
// Parse tool output into SwarmPanelData
// ---------------------------------------------------------------------------

export function parseSwarmOutput(toolName: string, output: string): SwarmPanelData | null {
  if (toolName !== 'spawn_subagent') return null
  try {
    const data = JSON.parse(output)

    // Batch result (completed)
    if (data.action === 'batch' && Array.isArray(data.results)) {
      return {
        kind: 'batch',
        status: data.failed > 0 ? 'partial' : 'completed',
        agents: data.results.map((r: any) => ({
          jobId: r.jobId || '',
          agentName: r.agentName || 'Agent',
          status: r.status || 'completed',
          response: r.response || null,
          error: r.error || null,
        })),
        completed: data.completed || 0,
        failed: data.failed || 0,
        cancelled: data.cancelled || 0,
        timedOut: data.timedOut || 0,
        totalDurationMs: data.totalDurationMs || 0,
        jobIds: data.jobIds || [],
      }
    }

    // Batch started (running)
    if (data.action === 'batch' && data.status === 'running') {
      const count = data.taskCount || data.jobIds?.length || 0
      return {
        kind: 'batch',
        status: 'running',
        agents: (data.jobIds || []).map((id: string, i: number) => ({
          jobId: id,
          agentName: `Agent ${i + 1}`,
          status: 'running' as const,
        })),
        jobIds: data.jobIds || [],
      }
    }

    // Swarm result (completed or running) — uses SwarmStatusCard rendering
    if (data.action === 'swarm' && data.snapshot) {
      const snap = data.snapshot
      return {
        kind: 'batch',
        status: snap.status === 'completed' ? 'completed'
          : snap.status === 'failed' ? 'failed'
          : snap.failedCount > 0 ? 'partial'
          : 'running',
        agents: (snap.members || []).map((m: any) => ({
          jobId: m.jobId || '',
          agentId: m.agentId,
          agentName: m.agentName || 'Agent',
          status: m.status === 'spawn_error' ? 'failed' : m.status || 'running',
          response: m.resultPreview || null,
          error: m.error || null,
          durationMs: m.durationMs,
        })),
        completed: snap.completedCount || 0,
        failed: snap.failedCount || 0,
        totalDurationMs: data.durationMs || 0,
        jobIds: [],
      }
    }

    // Swarm started (running, no snapshot yet)
    if (data.action === 'swarm' && data.status === 'running') {
      return {
        kind: 'batch',
        status: 'running',
        agents: Array.from({ length: data.memberCount || 0 }, (_, i) => ({
          jobId: '',
          agentName: `Agent ${i + 1}`,
          status: 'running' as const,
        })),
        jobIds: [],
      }
    }

    // Single spawn (background — running)
    if (data.status === 'running' && data.jobId) {
      return {
        kind: 'single',
        status: 'running',
        agents: [{
          jobId: data.jobId,
          agentId: data.agentId,
          agentName: data.agentName || 'Agent',
          status: 'running',
          lineageId: data.lineageId,
        }],
        jobIds: [data.jobId],
      }
    }

    // Single spawn (completed with result)
    if (data.jobId && data.status && data.agentName) {
      return {
        kind: 'single',
        status: data.status === 'completed' ? 'completed' : 'failed',
        agents: [{
          jobId: data.jobId,
          agentId: data.agentId,
          agentName: data.agentName,
          status: data.status,
          response: data.response || null,
          error: data.error || null,
          durationMs: data.durationMs,
          lineageId: data.lineageId,
          depth: data.depth,
        }],
        completed: data.status === 'completed' ? 1 : 0,
        failed: data.status === 'failed' ? 1 : 0,
        totalDurationMs: data.durationMs,
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Try to extract SwarmStatusData from a spawn_subagent swarm action output.
 * Returns data compatible with SwarmStatusCard when snapshot is present.
 */
export function parseSwarmStatusOutput(toolName: string, output: string): import('./swarm-status-card').SwarmStatusData | null {
  if (toolName !== 'spawn_subagent') return null
  try {
    const data = JSON.parse(output)
    if (data.action !== 'swarm' || !data.snapshot) return null
    const snap = data.snapshot
    return {
      swarmId: snap.swarmId || data.swarmId || '',
      parentSessionId: snap.parentSessionId || null,
      parentAgentName: 'Orchestrator',
      parentAgentSeed: null,
      status: snap.status || 'running',
      createdAt: snap.createdAt || Date.now(),
      completedAt: snap.completedAt || null,
      memberCount: snap.memberCount || 0,
      completedCount: snap.completedCount || 0,
      failedCount: snap.failedCount || 0,
      members: (snap.members || []).map((m: any) => ({
        index: m.index ?? 0,
        agentId: m.agentId || '',
        agentName: m.agentName || 'Agent',
        jobId: m.jobId || '',
        sessionId: m.sessionId || '',
        task: m.task || '',
        status: m.status || 'running',
        resultPreview: m.resultPreview || null,
        error: m.error || null,
        durationMs: m.durationMs || 0,
      })),
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Status Config
// ---------------------------------------------------------------------------

const STATUS_CONFIG = {
  running: { color: '#818CF8', bg: 'rgba(99,102,241,0.06)', border: 'rgba(99,102,241,0.12)', label: 'Running' },
  completed: { color: '#34D399', bg: 'rgba(52,211,153,0.06)', border: 'rgba(52,211,153,0.12)', label: 'Completed' },
  failed: { color: '#F43F5E', bg: 'rgba(244,63,94,0.06)', border: 'rgba(244,63,94,0.12)', label: 'Failed' },
  cancelled: { color: '#94A3B8', bg: 'rgba(148,163,184,0.06)', border: 'rgba(148,163,184,0.12)', label: 'Cancelled' },
  timed_out: { color: '#F59E0B', bg: 'rgba(245,158,11,0.06)', border: 'rgba(245,158,11,0.12)', label: 'Timed Out' },
  partial: { color: '#F59E0B', bg: 'rgba(245,158,11,0.06)', border: 'rgba(245,158,11,0.12)', label: 'Partial' },
} as const

function AgentStatusIcon({ status }: { status: SwarmAgent['status'] }) {
  const cfg = STATUS_CONFIG[status]
  if (status === 'running') {
    return <span className="w-3 h-3 shrink-0 rounded-full border-2 animate-spin" style={{ borderColor: cfg.color, borderTopColor: 'transparent' }} />
  }
  if (status === 'completed') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={cfg.color} strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )
  }
  if (status === 'failed') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={cfg.color} strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    )
  }
  if (status === 'cancelled') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={cfg.color} strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
        <circle cx="12" cy="12" r="10" />
        <line x1="8" y1="12" x2="16" y2="12" />
      </svg>
    )
  }
  // timed_out
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={cfg.color} strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

function formatDuration(ms: number | undefined): string {
  if (!ms) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}m`
}

// ---------------------------------------------------------------------------
// Agent Card
// ---------------------------------------------------------------------------

function SwarmAgentCard({ agent }: { agent: SwarmAgent }) {
  const [expanded, setExpanded] = useState(false)
  const cfg = STATUS_CONFIG[agent.status]
  const hasDetail = !!(agent.response || agent.error)

  return (
    <div
      className="rounded-[10px] overflow-hidden transition-all duration-200"
      style={{
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
      }}
    >
      <button
        type="button"
        onClick={() => hasDetail && setExpanded(!expanded)}
        disabled={!hasDetail}
        className={`w-full text-left flex items-center gap-2 px-3 py-2 bg-transparent border-none ${hasDetail ? 'cursor-pointer' : 'cursor-default'}`}
        style={{ fontFamily: 'inherit' }}
      >
        <AgentStatusIcon status={agent.status} />
        <span className="text-[12px] font-600 text-text-2 truncate flex-1">
          {agent.agentName}
        </span>
        {agent.durationMs != null && agent.durationMs > 0 && (
          <span className="text-[10px] text-text-3/50 font-mono shrink-0">
            {formatDuration(agent.durationMs)}
          </span>
        )}
        <span className="text-[10px] font-500 shrink-0" style={{ color: cfg.color }}>
          {cfg.label}
        </span>
        {hasDetail && (
          <svg
            width="10" height="10" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            className={`shrink-0 text-text-3/50 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>
      {expanded && hasDetail && (
        <div className="px-3 pb-2.5 border-t border-white/[0.04]">
          {agent.error && (
            <pre className="text-[11px] text-rose-400/80 font-mono whitespace-pre-wrap break-all mt-1.5 max-h-[120px] overflow-y-auto">
              {agent.error}
            </pre>
          )}
          {agent.response && (
            <pre className="text-[11px] text-text-3/70 font-mono whitespace-pre-wrap break-all mt-1.5 max-h-[200px] overflow-y-auto">
              {agent.response.length > 1500 ? `${agent.response.slice(0, 1500)}...` : agent.response}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Swarm Panel (main export)
// ---------------------------------------------------------------------------

export function SwarmPanel({ data }: { data: SwarmPanelData }) {
  const [showAll, setShowAll] = useState(false)
  const overallCfg = STATUS_CONFIG[data.status]
  const agentCount = data.agents.length
  const visibleAgents = showAll ? data.agents : data.agents.slice(0, 5)
  const hiddenCount = agentCount - visibleAgents.length

  const summaryParts = useMemo(() => {
    const parts: string[] = []
    if (data.completed) parts.push(`${data.completed} completed`)
    if (data.failed) parts.push(`${data.failed} failed`)
    if (data.cancelled) parts.push(`${data.cancelled} cancelled`)
    if (data.timedOut) parts.push(`${data.timedOut} timed out`)
    return parts
  }, [data.completed, data.failed, data.cancelled, data.timedOut])

  return (
    <div
      className="rounded-[14px] overflow-hidden"
      style={{
        background: overallCfg.bg,
        border: `1px solid ${overallCfg.border}`,
        animation: 'delegation-handoff-in 0.45s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2.5 px-4 py-2.5"
        style={{
          background: `${overallCfg.color}08`,
          borderBottom: `1px solid ${overallCfg.border}`,
        }}
      >
        {/* Swarm icon */}
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="shrink-0">
          <circle cx="12" cy="6" r="3" stroke={overallCfg.color} strokeWidth="2" />
          <circle cx="5" cy="18" r="3" stroke={overallCfg.color} strokeWidth="2" />
          <circle cx="19" cy="18" r="3" stroke={overallCfg.color} strokeWidth="2" />
          <line x1="12" y1="9" x2="5" y2="15" stroke={overallCfg.color} strokeWidth="1.5" />
          <line x1="12" y1="9" x2="19" y2="15" stroke={overallCfg.color} strokeWidth="1.5" />
        </svg>

        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className="text-[12px] font-700" style={{ color: overallCfg.color }}>
            {data.kind === 'batch' ? 'Swarm' : 'Subagent'} — {agentCount} agent{agentCount !== 1 ? 's' : ''}
          </span>
          {summaryParts.length > 0 && (
            <span className="text-[10px] text-text-3/60">
              {summaryParts.join(' · ')}
              {data.totalDurationMs ? ` · ${formatDuration(data.totalDurationMs)}` : ''}
            </span>
          )}
        </div>

        {data.status === 'running' && (
          <span
            className="w-3 h-3 shrink-0 rounded-full border-2 animate-spin"
            style={{ borderColor: overallCfg.color, borderTopColor: 'transparent' }}
          />
        )}
      </div>

      {/* Agent cards */}
      <div className="px-3 py-2.5 flex flex-col gap-1.5">
        {visibleAgents.map((agent) => (
          <SwarmAgentCard key={agent.jobId || agent.agentName} agent={agent} />
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="self-start px-2.5 py-1 rounded-[7px] bg-white/[0.04] hover:bg-white/[0.07] text-[11px] text-text-3 border border-white/[0.06] cursor-pointer transition-colors"
            style={{ fontFamily: 'inherit' }}
          >
            Show {hiddenCount} more agent{hiddenCount !== 1 ? 's' : ''}
          </button>
        )}
      </div>
    </div>
  )
}
