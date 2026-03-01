'use client'

import { AiAvatar } from '@/components/shared/avatar'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { useChatStore } from '@/stores/use-chat-store'

interface Props {
  assistantName?: string
  agentAvatarSeed?: string
  agentName?: string
}

export function ThinkingIndicator({ assistantName, agentAvatarSeed, agentName }: Props) {
  const streamPhase = useChatStore((s) => s.streamPhase)
  const streamToolName = useChatStore((s) => s.streamToolName)

  const statusText = streamPhase === 'tool' && streamToolName
    ? `Using ${streamToolName}...`
    : 'Thinking...'

  return (
    <div className="flex flex-col items-start"
      style={{ animation: 'msg-in-left 0.35s cubic-bezier(0.16, 1, 0.3, 1)' }}>
      <div className="flex items-center gap-2.5 mb-2 px-1">
        {agentName ? <AgentAvatar seed={agentAvatarSeed || null} name={agentName} size={36} /> : <AiAvatar size="sm" mood={streamPhase === 'tool' ? 'tool' : 'thinking'} />}
        <span className="text-[12px] font-600 text-text-3">{assistantName || 'Claude'}</span>
      </div>
      <div className="bubble-ai px-6 py-5">
        <div className="flex items-center gap-3">
          <div className="flex gap-2">
            <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite' }} />
            <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite 0.15s' }} />
            <span className="w-[6px] h-[6px] rounded-full bg-accent-bright/60" style={{ animation: 'dot-bounce 1.2s ease-in-out infinite 0.3s' }} />
          </div>
          <span className="text-[12px] text-text-3/60 font-mono">{statusText}</span>
        </div>
      </div>
    </div>
  )
}
