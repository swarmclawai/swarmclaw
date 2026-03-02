'use client'

import { useEffect, useState } from 'react'

const NOTABLE_TOOLS: Record<string, { label: string; color: string; icon: 'brain' | 'clipboard' | 'delegate' | 'search' | 'message' }> = {
  memory: { label: 'Committed to memory', color: '#A855F7', icon: 'brain' },
  memory_tool: { label: 'Committed to memory', color: '#A855F7', icon: 'brain' },
  manage_tasks: { label: 'Created a task', color: '#EC4899', icon: 'clipboard' },
  manage_schedules: { label: 'Scheduled something', color: '#EC4899', icon: 'clipboard' },
  manage_agents: { label: 'Created an agent', color: '#EC4899', icon: 'clipboard' },
  delegate_to_claude_code: { label: 'Delegated to Claude Code', color: '#38BDF8', icon: 'delegate' },
  delegate_to_codex_cli: { label: 'Delegated to Codex', color: '#38BDF8', icon: 'delegate' },
  delegate_to_opencode_cli: { label: 'Delegated to OpenCode', color: '#38BDF8', icon: 'delegate' },
  delegate_to_agent: { label: 'Delegating task', color: '#6366F1', icon: 'delegate' },
  check_delegation_status: { label: 'Checking delegation', color: '#6366F1', icon: 'delegate' },
  web_search: { label: 'Searched the web', color: '#22C55E', icon: 'search' },
  connector_message_tool: { label: 'Sent a message', color: '#F97316', icon: 'message' },
}

function extractSnippet(toolName: string, toolInput: string): string | null {
  try {
    const parsed = JSON.parse(toolInput)
    if ((toolName === 'memory' || toolName === 'memory_tool') && parsed.title) return parsed.title
    if ((toolName === 'memory' || toolName === 'memory_tool') && parsed.key) return parsed.key
    if (toolName === 'manage_tasks' && parsed.title) return parsed.title
    if (toolName === 'manage_schedules' && parsed.name) return parsed.name
    if (toolName === 'manage_agents' && parsed.name) return parsed.name
    if (toolName === 'delegate_to_agent' && (parsed.agentName || parsed.agentId)) return parsed.agentName || parsed.agentId
    if (toolName === 'check_delegation_status' && parsed.agentName) return parsed.agentName
    if (toolName.startsWith('delegate_to_') && parsed.task) return parsed.task
    if (toolName === 'web_search' && parsed.query) return parsed.query
    if (toolName === 'connector_message_tool' && parsed.to) return parsed.to
  } catch { /* ignore parse errors */ }
  return null
}

function MomentIcon({ icon, color }: { icon: string; color: string }) {
  switch (icon) {
    case 'brain':
      return (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
          <line x1="10" y1="22" x2="14" y2="22" />
        </svg>
      )
    case 'delegate':
      return (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round">
          <path d="M7 17l9.2-9.2M17 17V7H7" />
        </svg>
      )
    case 'search':
      return (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      )
    case 'message':
      return (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      )
    default: // clipboard
      return (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
        </svg>
      )
  }
}

interface Props {
  toolName: string
  toolInput: string
  onDismiss: () => void
}

export function ActivityMoment({ toolName, toolInput, onDismiss }: Props) {
  const config = NOTABLE_TOOLS[toolName]
  const [phase, setPhase] = useState<'in' | 'out'>('in')

  useEffect(() => {
    const holdTimer = setTimeout(() => setPhase('out'), 2000)
    const dismissTimer = setTimeout(onDismiss, 2500)
    return () => {
      clearTimeout(holdTimer)
      clearTimeout(dismissTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!config) return null

  const snippet = extractSnippet(toolName, toolInput)

  return (
    <div
      className="absolute bottom-full left-0 z-10 pointer-events-none mb-1.5"
      style={{
        animation: phase === 'in'
          ? 'activity-moment-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards'
          : 'activity-moment-out 0.4s cubic-bezier(0.4, 0, 1, 1) forwards',
      }}
    >
      <div
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] shadow-lg whitespace-nowrap"
        style={{
          background: 'var(--card)',
          border: `1px solid ${config.color}40`,
        }}
      >
        <MomentIcon icon={config.icon} color={config.color} />
        <span className="text-[10px] font-600" style={{ color: config.color }}>
          {config.label}
        </span>
        {snippet && (
          <span className="text-[10px] text-text-3/60 max-w-[120px] truncate">
            {snippet}
          </span>
        )}
      </div>
    </div>
  )
}

export function isNotableTool(name: string): boolean {
  return name in NOTABLE_TOOLS
}

const HEART_PATH = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'

export function HeartbeatMoment({ onDismiss }: { onDismiss: () => void }) {
  const [phase, setPhase] = useState<'in' | 'out'>('in')

  useEffect(() => {
    const holdTimer = setTimeout(() => setPhase('out'), 2000)
    const dismissTimer = setTimeout(onDismiss, 2500)
    return () => {
      clearTimeout(holdTimer)
      clearTimeout(dismissTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className="absolute bottom-full left-0 z-10 pointer-events-none mb-1.5"
      style={{
        animation: phase === 'in'
          ? 'activity-moment-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards'
          : 'activity-moment-out 0.4s cubic-bezier(0.4, 0, 1, 1) forwards',
      }}
    >
      <div
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] shadow-lg whitespace-nowrap"
        style={{
          background: 'var(--card)',
          border: '1px solid rgba(34,197,94,0.3)',
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="#22c55e">
          <path d={HEART_PATH} />
        </svg>
        <span className="text-[10px] font-600" style={{ color: '#22c55e' }}>
          Heartbeat OK
        </span>
      </div>
    </div>
  )
}
