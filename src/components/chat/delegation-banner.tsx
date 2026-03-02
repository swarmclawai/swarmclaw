'use client'

import { useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { api } from '@/lib/api-client'

type DelegationStatus = 'delegating' | 'checking' | 'completed' | 'failed'

interface DelegationBannerProps {
  agentName: string
  agentAvatarSeed: string | null
  taskPreview: string
  taskId: string | null
  status: DelegationStatus
}

const STATUS_CONFIG: Record<DelegationStatus, { color: string; bg: string; border: string }> = {
  delegating: { color: '#818CF8', bg: 'rgba(99,102,241,0.06)', border: 'rgba(99,102,241,0.12)' },
  checking: { color: '#818CF8', bg: 'rgba(99,102,241,0.06)', border: 'rgba(99,102,241,0.12)' },
  completed: { color: '#34D399', bg: 'rgba(52,211,153,0.06)', border: 'rgba(52,211,153,0.12)' },
  failed: { color: '#F43F5E', bg: 'rgba(244,63,94,0.06)', border: 'rgba(244,63,94,0.12)' },
}

function StatusIcon({ status, color }: { status: DelegationStatus; color: string }) {
  switch (status) {
    case 'delegating':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
          <path d="M5 12h14" />
          <path d="M12 5l7 7-7 7" />
        </svg>
      )
    case 'checking':
      return (
        <span className="w-3.5 h-3.5 shrink-0 rounded-full border-2 animate-spin" style={{ borderColor: color, borderTopColor: 'transparent' }} />
      )
    case 'completed':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )
    case 'failed':
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      )
  }
}

function statusText(status: DelegationStatus, name: string): string {
  switch (status) {
    case 'delegating': return `Delegated to ${name}`
    case 'checking': return `Checking on ${name}...`
    case 'completed': return `${name} completed`
    case 'failed': return `${name} failed`
  }
}

export function DelegationBanner({ agentName, agentAvatarSeed, taskPreview, taskId, status }: DelegationBannerProps) {
  const cfg = STATUS_CONFIG[status]

  const handleTaskClick = () => {
    if (!taskId) return
    const store = useAppStore.getState()
    store.loadTasks(true).then(() => {
      store.setTaskSheetViewOnly(true)
      store.setEditingTaskId(taskId)
      store.setTaskSheetOpen(true)
    })
  }

  return (
    <div
      className="rounded-[12px] px-3.5 py-2.5 flex items-center gap-2.5"
      style={{
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        animation: 'delegation-handoff-in 0.45s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      <div className="shrink-0" style={{ animation: 'delegation-handoff-in 0.45s cubic-bezier(0.16, 1, 0.3, 1) 0.05s both' }}>
        <AgentAvatar seed={agentAvatarSeed} name={agentName} size={24} />
      </div>
      <StatusIcon status={status} color={cfg.color} />
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <span className="text-[12px] font-600" style={{ color: cfg.color }}>
          {statusText(status, agentName)}
        </span>
        {taskPreview && (
          <span className="text-[11px] text-text-3 truncate">{taskPreview}</span>
        )}
      </div>
      {taskId && (
        <button
          type="button"
          onClick={handleTaskClick}
          className="shrink-0 text-[10px] font-600 px-2 py-1 rounded-[6px] cursor-pointer border-none transition-colors"
          style={{
            color: cfg.color,
            background: `${cfg.color}15`,
          }}
        >
          View Task
        </button>
      )}
    </div>
  )
}

/* ---------- Task Completion Card ---------- */

export interface TaskCompletionInfo {
  status: 'completed' | 'failed'
  taskTitle: string
  taskId: string | null
  /** The agent that executed the task (present on delegated results) */
  executorName: string | null
  workingDir: string | null
  resumeInfo: string | null
  resultBody: string
  imageUrl?: string
}

const TASK_COMPLETION_RE = /^(?:Delegated )?[Tt]ask (completed|failed): \*\*\[([^\]]+)\]\(#task:([^)]+)\)\*\*(?:\s*\(by ([^)]+)\))?/

export function parseTaskCompletion(text: string): TaskCompletionInfo | null {
  const m = text.match(TASK_COMPLETION_RE)
  if (!m) return null
  const status = m[1] as 'completed' | 'failed'
  const taskTitle = m[2]
  const taskId = m[3] || null
  const executorName = m[4] || null

  // Parse the body sections (separated by double newlines)
  const bodyStart = text.indexOf('\n\n')
  const sections = bodyStart === -1 ? [] : text.slice(bodyStart + 2).split('\n\n')

  let workingDir: string | null = null
  let resumeInfo: string | null = null
  const resultParts: string[] = []

  for (const section of sections) {
    if (section.startsWith('Working directory: ')) {
      workingDir = section.replace('Working directory: ', '').replace(/^`|`$/g, '')
    } else if (/^(Claude session|Codex thread|OpenCode session|CLI session):/.test(section)) {
      resumeInfo = section
    } else if (section.trim()) {
      resultParts.push(section)
    }
  }

  return { status, taskTitle, taskId, executorName, workingDir, resumeInfo, resultBody: resultParts.join('\n\n') }
}

export function TaskCompletionCard({ info }: { info: TaskCompletionInfo }) {
  const isSuccess = info.status === 'completed'
  const [expanded, setExpanded] = useState(false)

  const handleTaskClick = () => {
    if (!info.taskId) return
    const store = useAppStore.getState()
    store.loadTasks(true).then(() => {
      store.setTaskSheetViewOnly(true)
      store.setEditingTaskId(info.taskId!)
      store.setTaskSheetOpen(true)
    })
  }

  // Truncate result for preview
  const resultPreview = info.resultBody.length > 200 ? info.resultBody.slice(0, 200) + '...' : info.resultBody
  const hasLongResult = info.resultBody.length > 200

  return (
    <div
      className="rounded-[14px] overflow-hidden"
      style={{
        background: isSuccess ? 'rgba(52,211,153,0.04)' : 'rgba(244,63,94,0.04)',
        border: `1px solid ${isSuccess ? 'rgba(52,211,153,0.15)' : 'rgba(244,63,94,0.15)'}`,
        animation: 'delegation-handoff-in 0.45s cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {/* Status header bar */}
      <div
        className="flex items-center gap-2.5 px-4 py-2.5"
        style={{
          background: isSuccess ? 'rgba(52,211,153,0.06)' : 'rgba(244,63,94,0.06)',
          borderBottom: `1px solid ${isSuccess ? 'rgba(52,211,153,0.08)' : 'rgba(244,63,94,0.08)'}`,
        }}
      >
        {/* Status icon */}
        {isSuccess ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="shrink-0">
            <circle cx="12" cy="12" r="10" stroke="#34D399" strokeWidth="2" />
            <polyline points="8 12 11 15 16 9" stroke="#34D399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="shrink-0">
            <circle cx="12" cy="12" r="10" stroke="#F43F5E" strokeWidth="2" />
            <line x1="15" y1="9" x2="9" y2="15" stroke="#F43F5E" strokeWidth="2.5" strokeLinecap="round" />
            <line x1="9" y1="9" x2="15" y2="15" stroke="#F43F5E" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        )}

        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span className={`text-[12px] font-700 ${isSuccess ? 'text-emerald-400' : 'text-rose-400'}`}>
            {info.executorName
              ? `${info.executorName} — task ${info.status}`
              : `Task ${info.status}`
            }
          </span>
        </div>

        {info.taskId && (
          <button
            type="button"
            onClick={handleTaskClick}
            className="shrink-0 text-[10px] font-600 px-2.5 py-1 rounded-[6px] cursor-pointer border-none transition-colors"
            style={{
              color: isSuccess ? '#34D399' : '#F43F5E',
              background: isSuccess ? 'rgba(52,211,153,0.1)' : 'rgba(244,63,94,0.1)',
            }}
          >
            View Task
          </button>
        )}
      </div>

      {/* Body content */}
      <div className="px-4 py-3 flex flex-col gap-2.5">
        {/* Task title */}
        <div className="flex items-start gap-2">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 mt-0.5 text-text-3/50">
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          {info.taskId ? (
            <button
              type="button"
              onClick={handleTaskClick}
              className={`text-[13px] font-600 ${isSuccess ? 'text-emerald-300 hover:text-emerald-200' : 'text-rose-300 hover:text-rose-200'} cursor-pointer bg-transparent border-none p-0 font-inherit text-left underline decoration-current/30 hover:decoration-current/60 transition-colors`}
            >
              {info.taskTitle}
            </button>
          ) : (
            <span className="text-[13px] font-600 text-text-2">{info.taskTitle}</span>
          )}
        </div>

        {/* Working directory */}
        {info.workingDir && (
          <div className="flex items-center gap-2">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-text-3/40">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <button
              type="button"
              onClick={() => { api('POST', '/files/open', { path: info.workingDir }).catch(() => {}) }}
              className="text-[11px] text-text-3/60 hover:text-text-3 font-mono truncate bg-transparent border-none p-0 cursor-pointer transition-colors"
              title="Open folder"
            >
              {info.workingDir}
            </button>
          </div>
        )}

        {/* Resume info */}
        {info.resumeInfo && (
          <div className="flex items-center gap-2">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-text-3/40">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span className="text-[11px] text-text-3/60 font-mono truncate">{info.resumeInfo}</span>
          </div>
        )}

        {/* Image artifact */}
        {info.imageUrl && (
          <div className="mt-0.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={info.imageUrl}
              alt="Task result"
              loading="lazy"
              className="max-w-full rounded-[10px] border border-white/[0.06]"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          </div>
        )}

        {/* Result body */}
        {info.resultBody && (
          <div className="mt-0.5">
            <div className="rounded-[10px] bg-white/[0.02] border border-white/[0.04] px-3 py-2.5">
              <pre className="text-[12px] leading-[1.6] text-text-3/80 whitespace-pre-wrap break-words m-0 font-mono">
                {expanded ? info.resultBody : resultPreview}
              </pre>
              {hasLongResult && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="mt-2 text-[11px] font-600 text-text-3/50 hover:text-text-3 bg-transparent border-none cursor-pointer p-0 transition-colors"
                >
                  {expanded ? 'Show less' : 'Show full result'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------- Delegation Source Banner ---------- */

interface DelegationSourceBannerProps {
  delegatorName: string
  delegatorAvatarSeed: string | null
  taskTitle: string
  taskId: string | null
  description: string
}

export function DelegationSourceBanner({ delegatorName, delegatorAvatarSeed, taskTitle, taskId, description }: DelegationSourceBannerProps) {
  const handleTaskClick = () => {
    if (!taskId) return
    const store = useAppStore.getState()
    store.loadTasks(true).then(() => {
      store.setTaskSheetViewOnly(true)
      store.setEditingTaskId(taskId)
      store.setTaskSheetOpen(true)
    })
  }

  return (
    <div
      className="rounded-[12px] px-3.5 py-2.5 flex items-start gap-2.5 bg-indigo-500/[0.05] border border-indigo-500/[0.12]"
      style={{ animation: 'delegation-handoff-in 0.45s cubic-bezier(0.16, 1, 0.3, 1)' }}
    >
      <div className="shrink-0 mt-0.5" style={{ animation: 'delegation-handoff-in 0.45s cubic-bezier(0.16, 1, 0.3, 1) 0.05s both' }}>
        <AgentAvatar seed={delegatorAvatarSeed} name={delegatorName} size={24} />
      </div>
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <span className="text-[12px] font-600 text-indigo-400">
          Delegated by {delegatorName}
        </span>
        {taskTitle && (
          taskId ? (
            <button
              type="button"
              onClick={handleTaskClick}
              className="text-[12px] text-indigo-300 hover:text-indigo-200 underline cursor-pointer bg-transparent border-none p-0 font-inherit text-left truncate"
            >
              {taskTitle}
            </button>
          ) : (
            <span className="text-[12px] text-text-2 truncate">{taskTitle}</span>
          )
        )}
        {description && (
          <span className="text-[11px] text-text-3 line-clamp-2">{description}</span>
        )}
      </div>
    </div>
  )
}
