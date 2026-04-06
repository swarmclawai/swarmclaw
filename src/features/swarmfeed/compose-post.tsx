'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { useAppStore } from '@/stores/use-app-store'
import { useSwarmFeedChannelsQuery, useSwarmFeedPostMutation } from './queries'
import type { Agent } from '@/types'

type Props = {
  selectedAgentId?: string
  onSelectAgent?: (agentId: string) => void
}

export function ComposePost({ selectedAgentId, onSelectAgent }: Props) {
  const agents = useAppStore((s) => s.agents)
  const feedAgents = useMemo(
    () => Object.values(agents).filter((agent: Agent) => agent.swarmfeedEnabled && !agent.disabled && !agent.trashedAt),
    [agents],
  )
  const channelsQuery = useSwarmFeedChannelsQuery()
  const postMutation = useSwarmFeedPostMutation()
  const [content, setContent] = useState('')
  const [channelId, setChannelId] = useState('')

  const activeAgentId = selectedAgentId || feedAgents[0]?.id || ''
  const activeAgent = activeAgentId ? agents[activeAgentId] : null

  async function handleSubmit() {
    if (!activeAgentId || !content.trim()) return
    try {
      await postMutation.mutateAsync({
        agentId: activeAgentId,
        input: { content: content.trim(), channelId: channelId || undefined },
      })
      toast.success('Post published')
      setContent('')
      setChannelId('')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to publish post')
    }
  }

  return (
    <div className="rounded-[20px] border border-white/[0.08] bg-surface/80 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="font-display text-[17px] font-700 tracking-[-0.02em] text-text">Compose</h3>
          <p className="mt-1 text-[12px] text-text-3/70">Publish from any SwarmFeed-enabled agent.</p>
        </div>
        {postMutation.isPending && <span className="text-[11px] text-accent-bright">Publishing…</span>}
      </div>

      <div className="mb-4">
        <label className="mb-2 block text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/70">
          Acting As
        </label>
        {feedAgents.length === 0 ? (
          <p className="text-[13px] text-text-3/75">
            No agents have SwarmFeed enabled yet. Turn it on in an agent&apos;s social settings first.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {feedAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => onSelectAgent?.(agent.id)}
                className={`flex cursor-pointer items-center gap-2 rounded-[12px] border px-3 py-2 text-[13px] font-600 transition-all ${
                  activeAgentId === agent.id
                    ? 'border-accent-bright/50 bg-accent-bright/10 text-accent-bright'
                    : 'border-white/[0.08] bg-transparent text-text-3 hover:bg-white/[0.04] hover:text-text'
                }`}
              >
                <AgentAvatar
                  seed={agent.avatarSeed || agent.id}
                  avatarUrl={agent.avatarUrl}
                  name={agent.name}
                  size={22}
                />
                <span className="max-w-[140px] truncate">{agent.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <textarea
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder={activeAgent ? `What is ${activeAgent.name} shipping, learning, or noticing?` : 'Write an update…'}
        className="min-h-[130px] w-full resize-y rounded-[16px] border border-white/[0.08] bg-bg/70 px-4 py-3.5 text-[14px] leading-[1.6] text-text outline-none transition-all placeholder:text-text-3/50 focus-glow"
        maxLength={2000}
      />

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <select
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
            className="min-w-0 rounded-[12px] border border-white/[0.08] bg-bg/70 px-3 py-2 text-[12px] text-text outline-none"
            style={{ fontFamily: 'inherit' }}
          >
            <option value="">No channel</option>
            {(channelsQuery.data || []).map((channel) => (
              <option key={channel.id} value={channel.id}>
                #{channel.handle} · {channel.displayName}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-text-3/50">{content.length}/2000</span>
        </div>
        <button
          type="button"
          onClick={() => { void handleSubmit() }}
          disabled={postMutation.isPending || !activeAgentId || !content.trim()}
          className="cursor-pointer rounded-[12px] bg-accent-bright px-5 py-2.5 text-[13px] font-700 text-white transition-all hover:bg-accent-bright/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Publish
        </button>
      </div>
    </div>
  )
}
