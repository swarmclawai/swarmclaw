'use client'

import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AiAvatar } from '@/components/shared/avatar'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { useChatStore } from '@/stores/use-chat-store'

interface Props {
  assistantName?: string
  agentAvatarSeed?: string
  agentAvatarUrl?: string | null
  agentName?: string
}

function ElapsedTimer({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!startTime) return
    const tick = () => setElapsed(Math.floor((Date.now() - startTime) / 1000))
    tick()
    const id = setInterval(tick, 250)
    return () => clearInterval(id)
  }, [startTime])

  if (!elapsed) return null
  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  return (
    <span className="text-[10px] text-text-3/50 font-mono tabular-nums">
      {mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}
    </span>
  )
}

export function ThinkingIndicator({ assistantName, agentAvatarSeed, agentAvatarUrl, agentName }: Props) {
  const streamPhase = useChatStore((s) => s.streamPhase)
  const streamToolName = useChatStore((s) => s.streamToolName)
  const thinkingText = useChatStore((s) => s.thinkingText)
  const thinkingStartTime = useChatStore((s) => s.thinkingStartTime)

  const statusText = streamPhase === 'tool' && streamToolName
    ? `Using ${streamToolName}...`
    : 'Thinking...'

  const hasThinkingContent = thinkingText.trim().length > 0

  return (
    <div className="flex flex-col items-start relative pl-[44px]"
      style={{ animation: 'msg-in-left 0.35s cubic-bezier(0.16, 1, 0.3, 1)' }}>
      <div className="absolute left-[4px] top-0">
        {agentName ? <AgentAvatar seed={agentAvatarSeed || null} avatarUrl={agentAvatarUrl} name={agentName} size={28} /> : <AiAvatar size="sm" mood={streamPhase === 'tool' ? 'tool' : 'thinking'} />}
      </div>
      <div className="flex items-center gap-2.5 mb-2 px-1">
        <span className="text-[12px] font-600 text-text-3">{assistantName || 'Claude'}</span>
      </div>

      {hasThinkingContent ? (
        <details className="group/think w-full max-w-[85%] md:max-w-[72%]">
          <summary className="bubble-ai px-5 py-3.5 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            <div className="flex items-center gap-3">
              <div className="flex gap-2">
                <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite' }} />
                <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite 0.15s' }} />
                <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite 0.3s' }} />
              </div>
              <span className="text-[12px] text-text-3/60 font-mono">{statusText}</span>
              <ElapsedTimer startTime={thinkingStartTime} />
              <svg
                width="12" height="12" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                className="shrink-0 text-text-3/50 transition-transform duration-200 group-open/think:rotate-180 ml-auto"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </summary>
          <div className="mt-2 px-4 py-3 rounded-[12px] bg-bg/60 border border-white/[0.04] max-h-[300px] overflow-y-auto">
            <div className="msg-content text-[13px] leading-[1.6] text-text-3/80">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {thinkingText}
              </ReactMarkdown>
            </div>
          </div>
        </details>
      ) : (
        <div className="bubble-ai px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex gap-2">
              <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite' }} />
              <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite 0.15s' }} />
              <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite 0.3s' }} />
            </div>
            <span className="text-[12px] text-text-3/60 font-mono">{statusText}</span>
            <ElapsedTimer startTime={thinkingStartTime} />
          </div>
        </div>
      )}
    </div>
  )
}
