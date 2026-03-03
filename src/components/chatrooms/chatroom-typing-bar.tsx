'use client'

import type { ReactNode } from 'react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { useAppStore } from '@/stores/use-app-store'
import type { Agent } from '@/types'

/** Render text with @mentions highlighted */
function renderWithMentions(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  let lastIndex = 0
  const regex = /@\S+/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    parts.push(
      <span key={match.index} className="text-accent-bright font-600 bg-accent-soft/40 px-0.5 rounded">
        {match[0]}
      </span>
    )
    lastIndex = regex.lastIndex
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }
  return parts
}

interface Props {
  streamingAgents: Map<string, { text: string; name: string; error?: string }>
}

export function ChatroomTypingBar({ streamingAgents }: Props) {
  const agents = useAppStore((s) => s.agents) as Record<string, Agent>

  if (streamingAgents.size === 0) return null

  const entries = Array.from(streamingAgents.entries())
  const errors = entries.filter(([, a]) => a.error)
  const active = entries.filter(([, a]) => !a.error)

  return (
    <div className="flex flex-col gap-1" style={{ animation: 'msg-in 0.2s ease-out both' }}>
      {/* Error indicators */}
      {errors.map(([agentId, a]) => (
        <div key={agentId} className="flex items-center gap-2 px-4 py-1.5 text-[12px] text-red-400">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{a.name} — {a.error}</span>
        </div>
      ))}

      {/* Live streaming messages — show as inline message bubbles */}
      {active.map(([agentId, a]) => {
        const agent = agents[agentId]
        const hasText = a.text.trim().length > 0

        return (
          <div key={agentId} className="flex gap-2.5 px-4 py-1.5" style={{ animation: 'msg-in 0.2s ease-out both' }}>
            <div className="shrink-0 mt-0.5 w-7">
              <AgentAvatar seed={agent?.avatarSeed || null} avatarUrl={agent?.avatarUrl} name={a.name} size={28} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2 mb-0.5">
                <span className="text-[13px] font-600 text-accent-bright">{a.name}</span>
                <div className="flex gap-0.5 items-center label-mono text-accent-bright/60">
                  <span className="w-1 h-1 rounded-full bg-accent-bright animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1 h-1 rounded-full bg-accent-bright animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1 h-1 rounded-full bg-accent-bright animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
              {hasText && (
                <div className="text-[13px] text-text/70 leading-[1.5] break-words whitespace-pre-wrap">
                  {renderWithMentions(a.text)}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
