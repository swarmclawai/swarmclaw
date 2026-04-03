'use client'

import { useState, useCallback, useEffect } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { submitPost, fetchChannels } from './queries'
import { toast } from 'sonner'
import type { Agent } from '@/types'
import type { SwarmFeedChannel, SwarmFeedPost } from '@/types/swarmfeed'

export function ComposePost({ onPostCreated, onClose }: {
  onPostCreated?: (post: SwarmFeedPost) => void
  onClose?: () => void
}) {
  const agents = useAppStore((s) => s.agents)
  const feedAgents = Object.values(agents).filter(
    (a: Agent) => a.swarmfeedEnabled && !a.disabled && !a.trashedAt,
  )

  const [selectedAgentId, setSelectedAgentId] = useState<string>(feedAgents[0]?.id || '')
  const [content, setContent] = useState('')
  const [channelId, setChannelId] = useState('')
  const [channels, setChannels] = useState<SwarmFeedChannel[]>([])
  const [posting, setPosting] = useState(false)

  useEffect(() => {
    fetchChannels().then(setChannels).catch(() => { /* channels are optional */ })
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!selectedAgentId || !content.trim()) return
    setPosting(true)
    try {
      const post = await submitPost(selectedAgentId, content.trim(), channelId || undefined)
      toast.success('Post published')
      setContent('')
      onPostCreated?.(post)
      onClose?.()
    } catch {
      toast.error('Failed to publish post')
    } finally {
      setPosting(false)
    }
  }, [selectedAgentId, content, channelId, onPostCreated, onClose])

  const selectedAgent = selectedAgentId ? agents[selectedAgentId] : null

  return (
    <div className="rounded-[20px] border border-white/[0.08] bg-surface p-5 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display text-[17px] font-700 tracking-[-0.02em] text-text">Compose Post</h3>
        {onClose && (
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-[10px] flex items-center justify-center text-text-3 hover:text-text hover:bg-white/[0.06] transition-all bg-transparent border-none cursor-pointer"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* Agent picker */}
      <div className="mb-4">
        <label className="block text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
          Post as
        </label>
        {feedAgents.length === 0 ? (
          <p className="text-[13px] text-text-3/75">
            No agents have SwarmFeed enabled. Enable it in an agent&apos;s settings first.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {feedAgents.map((agent) => (
              <button
                key={agent.id}
                onClick={() => setSelectedAgentId(agent.id)}
                className={`flex items-center gap-2 px-3 py-2 rounded-[12px] border text-[13px] font-500 transition-all cursor-pointer bg-transparent
                  ${selectedAgentId === agent.id
                    ? 'border-accent-bright/40 bg-accent-bright/10 text-accent-bright'
                    : 'border-white/[0.08] text-text-3 hover:text-text hover:bg-white/[0.04]'
                  }`}
              >
                <AgentAvatar seed={agent.avatarSeed || null} avatarUrl={agent.avatarUrl} name={agent.name} size={22} />
                <span className="truncate max-w-[120px]">{agent.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="mb-4">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={selectedAgent ? `What's ${selectedAgent.name} thinking?` : 'Write something...'}
          className="w-full min-h-[120px] px-4 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[15px] outline-none transition-all duration-200 placeholder:text-text-3/50 focus-glow resize-y"
          style={{ fontFamily: 'inherit' }}
          maxLength={2000}
        />
        <div className="mt-1 text-right text-[11px] text-text-3/40">{content.length}/2000</div>
      </div>

      {/* Channel selector */}
      {channels.length > 0 && (
        <div className="mb-4">
          <label className="block text-[12px] font-600 text-text-2 uppercase tracking-[0.08em] mb-2">
            Channel (optional)
          </label>
          <select
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            className="w-full px-4 py-3 rounded-[14px] border border-white/[0.08] bg-surface text-text text-[14px] outline-none cursor-pointer"
            style={{ fontFamily: 'inherit' }}
          >
            <option value="">No channel</option>
            {channels.map((ch) => (
              <option key={ch.id} value={ch.id}>#{ch.handle} - {ch.displayName}</option>
            ))}
          </select>
        </div>
      )}

      {/* Submit */}
      <div className="flex justify-end">
        <button
          onClick={handleSubmit}
          disabled={posting || !selectedAgentId || !content.trim()}
          className="px-6 py-2.5 rounded-[12px] bg-accent-bright text-white text-[14px] font-600 transition-all
            hover:bg-accent-bright/90 disabled:opacity-40 disabled:cursor-not-allowed border-none cursor-pointer"
        >
          {posting ? 'Publishing...' : 'Publish'}
        </button>
      </div>
    </div>
  )
}
