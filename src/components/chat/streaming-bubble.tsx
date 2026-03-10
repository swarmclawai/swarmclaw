'use client'

import { memo, useState, useMemo } from 'react'
import { AiAvatar } from '@/components/shared/avatar'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { ActivityMoment, isNotableTool } from './activity-moment'
import { ToolEventsSection } from './tool-events-section'
import { useChatStore } from '@/stores/use-chat-store'
import { isStructuredMarkdown } from './markdown-utils'

interface Props {
  text: string
  assistantName?: string
  agentAvatarSeed?: string
  agentAvatarUrl?: string | null
  agentName?: string
}

export const StreamingBubble = memo(function StreamingBubble({ text, assistantName, agentAvatarSeed, agentAvatarUrl, agentName }: Props) {
  const toolEvents = useChatStore((s) => s.toolEvents)
  const streamPhase = useChatStore((s) => s.streamPhase)
  const streamToolName = useChatStore((s) => s.streamToolName)
  const thinkingText = useChatStore((s) => s.thinkingText)
  const wide = useMemo(() => isStructuredMarkdown(text), [text])

  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())

  let currentMoment: { id: string; name: string; input: string } | null = null
  for (let i = toolEvents.length - 1; i >= 0; i--) {
    const event = toolEvents[i]
    if (event.status === 'done' && isNotableTool(event.name) && !dismissedIds.has(event.id)) {
      currentMoment = { id: event.id, name: event.name, input: event.input }
      break
    }
  }

  const handleDismiss = (momentId: string) => {
    setDismissedIds((prev) => new Set(prev).add(momentId))
  }

  return (
    <div
      className="flex flex-col items-start relative pl-[44px]"
      style={{ animation: 'msg-in-left 0.4s var(--ease-spring) both' }}
    >
      <div className="absolute left-[4px] top-0 relative">
        {agentName ? <AgentAvatar seed={agentAvatarSeed || null} avatarUrl={agentAvatarUrl} name={agentName} size={28} /> : <AiAvatar size="sm" mood={streamPhase === 'tool' ? 'tool' : 'thinking'} />}
        {currentMoment && (
          <ActivityMoment
            key={currentMoment.id}
            toolName={currentMoment.name}
            toolInput={currentMoment.input}
            onDismiss={() => handleDismiss(currentMoment!.id)}
          />
        )}
      </div>
      <div className="flex items-center gap-2.5 mb-2 px-1">
        <span className="text-[12px] font-600 text-text-3">{assistantName || 'Claude'}</span>
        <span className="w-2 h-2 rounded-full bg-accent-bright" style={{ animation: 'pulse 1.5s ease infinite' }} />
        {streamPhase === 'tool' && streamToolName && (
          <span className="text-[10px] text-text-3/50 font-mono">Using {streamToolName}...</span>
        )}
      </div>

      {text && thinkingText && (
        <div className="max-w-[85%] md:max-w-[72%] mb-2">
          <details className="group rounded-[12px] border border-purple-500/15 bg-purple-500/[0.04]">
            <summary className="flex items-center gap-2 px-3.5 py-2.5 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden relative overflow-hidden group-open:rounded-b-none">
              <div className="absolute inset-0 bg-purple-500/5 opacity-0 group-hover:opacity-100 transition-opacity" style={{ animation: 'pulse-subtle 3s ease-in-out infinite' }} />
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-purple-400/60 shrink-0 transition-transform group-open:rotate-90 relative z-10">
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span className="text-[11px] font-600 text-purple-400/70 uppercase tracking-[0.05em] relative z-10">Thinking</span>
            </summary>
            <div className="px-3.5 pb-3 pt-1 max-h-[300px] overflow-y-auto border-t border-white/[0.04]">
              <div className="text-[13px] leading-[1.6] text-text-3/70 whitespace-pre-wrap break-words">
                {thinkingText}
              </div>
            </div>
          </details>
        </div>
      )}

      {toolEvents.length > 0 && (
        <ToolEventsSection toolEvents={toolEvents} />
      )}

      {text && (
        <div className={`${wide ? 'max-w-[92%] md:max-w-[85%]' : 'max-w-[85%] md:max-w-[72%]'} bubble-ai px-5 py-3.5`}>
          <div className="streaming-cursor text-[15px] leading-[1.7] break-words text-text whitespace-pre-wrap">
            {text}
          </div>
        </div>
      )}
    </div>
  )
})
