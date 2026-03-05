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
  const agentStatus = useChatStore((s) => s.agentStatus)

  const statusText = streamPhase === 'tool' && streamToolName
    ? `Using ${streamToolName}...`
    : 'Thinking...'

  const hasThinkingContent = thinkingText.trim().length > 0
  const hasMission = !!agentStatus?.goal

  return (
    <div className="flex flex-col items-start relative pl-[44px]"
      style={{ animation: 'msg-in-left 0.4s var(--ease-spring) both' }}>
      <div className="absolute left-[4px] top-0">
        {agentName ? <AgentAvatar seed={agentAvatarSeed || null} avatarUrl={agentAvatarUrl} name={agentName} size={28} /> : <AiAvatar size="sm" mood={streamPhase === 'tool' ? 'tool' : 'thinking'} />}
      </div>
      
      <div className="flex items-center gap-2.5 mb-2 px-1">
        <span className="text-[12px] font-600 text-text-3">{assistantName || 'Claude'}</span>
        {agentStatus?.status && (
          <span className={`px-1.5 py-0.5 rounded-[4px] text-[9px] font-700 uppercase tracking-wider ${
            agentStatus.status === 'progress' ? 'bg-blue-500/10 text-blue-400' :
            agentStatus.status === 'ok' ? 'bg-emerald-500/10 text-emerald-400' :
            agentStatus.status === 'blocked' ? 'bg-red-500/10 text-red-400' :
            'bg-white/[0.06] text-text-3'
          }`} style={{ animation: 'spring-in 0.3s var(--ease-spring)' }}>
            {agentStatus.status}
          </span>
        )}
      </div>

      {hasMission && (
        <div className="mb-2 w-full max-w-[85%] md:max-w-[72%] p-3 rounded-[12px] border border-accent-bright/10 bg-accent-bright/[0.02]"
          style={{ animation: 'fade-up 0.4s var(--ease-spring)' }}>
          <div className="text-[10px] font-700 text-accent-bright/60 uppercase tracking-widest mb-1.5 flex items-center gap-2">
            <span className="w-1 h-1 rounded-full bg-accent-bright/40" />
            Active Mission
          </div>
          <p className="text-[13px] font-500 text-text-2 leading-snug">{agentStatus.goal}</p>
          {agentStatus.nextAction && (
            <div className="mt-2 pt-2 border-t border-white/[0.04]">
              <span className="text-[10px] font-600 text-text-3/40 uppercase block mb-0.5">Next Action</span>
              <p className="text-[11px] text-text-3/80 italic">&ldquo;{agentStatus.nextAction}&rdquo;</p>
            </div>
          )}
        </div>
      )}

      {hasThinkingContent ? (
        <details className="group/think w-full max-w-[85%] md:max-w-[72%]">
          <summary className="bubble-ai px-5 py-3.5 cursor-pointer list-none [&::-webkit-details-marker]:hidden relative overflow-hidden group-open/think:rounded-b-none border border-transparent hover:border-white/[0.04] transition-all">
            {/* Thinking pulse background */}
            <div className="absolute inset-0 bg-accent-bright/5 opacity-0 group-hover/think:opacity-100 transition-opacity" style={{ animation: 'pulse-subtle 2s ease-in-out infinite' }} />
            
            <div className="flex items-center gap-3 relative z-10">
              <div className="flex gap-2">
                <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60 shadow-[0_0_8px_rgba(129,140,248,0.4)]" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite' }} />
                <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60 shadow-[0_0_8px_rgba(129,140,248,0.4)]" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite 0.15s' }} />
                <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60 shadow-[0_0_8px_rgba(129,140,248,0.4)]" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite 0.3s' }} />
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
          <div className="px-4 py-3 rounded-b-[12px] bg-bg/60 border-x border-b border-white/[0.04] max-h-[300px] overflow-y-auto">
            <div className="msg-content text-[13px] leading-[1.6] text-text-3/80">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {thinkingText}
              </ReactMarkdown>
            </div>
          </div>
        </details>
      ) : (
        <div className="bubble-ai px-6 py-5 relative overflow-hidden">
          {/* Thinking glow effect */}
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-accent-bright/5 to-transparent" style={{ animation: 'shimmer-bar 3s linear infinite' }} />
          
          <div className="flex items-center gap-3 relative z-10">
            <div className="flex gap-2">
              <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60 shadow-[0_0_8px_rgba(129,140,248,0.4)]" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite' }} />
              <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60 shadow-[0_0_8px_rgba(129,140,248,0.4)]" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite 0.15s' }} />
              <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60 shadow-[0_0_8px_rgba(129,140,248,0.4)]" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite 0.3s' }} />
            </div>
            <span className="text-[12px] text-text-3/60 font-mono">{statusText}</span>
            <ElapsedTimer startTime={thinkingStartTime} />
          </div>
        </div>
      )}
    </div>
  )
}
