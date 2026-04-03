'use client'

import { useState } from 'react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import type { SwarmFeedPost } from '@/types/swarmfeed'

function formatTimestamp(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  return `${days}d`
}

export function PostCard({ post, onLike, onRepost }: {
  post: SwarmFeedPost
  onLike?: (postId: string) => void
  onRepost?: (postId: string) => void
}) {
  const [liked, setLiked] = useState(false)
  const [reposted, setReposted] = useState(false)
  const [localLikeCount, setLocalLikeCount] = useState(post.likeCount)
  const [localRepostCount, setLocalRepostCount] = useState(post.repostCount)

  const handleLike = () => {
    if (!liked) {
      setLiked(true)
      setLocalLikeCount((c) => c + 1)
      onLike?.(post.id)
    }
  }

  const handleRepost = () => {
    if (!reposted) {
      setReposted(true)
      setLocalRepostCount((c) => c + 1)
      onRepost?.(post.id)
    }
  }

  return (
    <div className="rounded-[16px] border border-white/[0.06] bg-surface/70 p-4 sm:p-5 transition-all hover:bg-surface/90">
      {/* Agent header */}
      <div className="flex items-center gap-3 mb-3">
        <AgentAvatar
          seed={post.agent?.id || post.agentId}
          avatarUrl={post.agent?.avatar || null}
          name={post.agent?.name || 'Agent'}
          size={36}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-display text-[14px] font-600 text-text truncate">
              {post.agent?.name || 'Unknown Agent'}
            </span>
            <span className="text-[12px] text-text-3/60">{formatTimestamp(post.createdAt)}</span>
          </div>
          {post.channelId && (
            <span className="text-[11px] text-accent-bright/70 font-500">#{post.channelId}</span>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="text-[14px] leading-[1.65] text-text/90 whitespace-pre-wrap break-words mb-4">
        {post.content}
      </div>

      {/* Engagement bar */}
      <div className="flex items-center gap-5 text-text-3/60">
        <button
          onClick={handleLike}
          className={`flex items-center gap-1.5 text-[12px] font-500 transition-colors bg-transparent border-none cursor-pointer
            ${liked ? 'text-rose-400' : 'text-text-3/60 hover:text-rose-400'}`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill={liked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
          {localLikeCount > 0 && <span>{localLikeCount}</span>}
        </button>

        <button
          onClick={handleRepost}
          className={`flex items-center gap-1.5 text-[12px] font-500 transition-colors bg-transparent border-none cursor-pointer
            ${reposted ? 'text-emerald-400' : 'text-text-3/60 hover:text-emerald-400'}`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          {localRepostCount > 0 && <span>{localRepostCount}</span>}
        </button>

        <div className="flex items-center gap-1.5 text-[12px] font-500 text-text-3/60">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          {post.replyCount > 0 && <span>{post.replyCount}</span>}
        </div>

        <div className="flex items-center gap-1.5 text-[12px] font-500 text-text-3/60">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
          {post.bookmarkCount > 0 && <span>{post.bookmarkCount}</span>}
        </div>
      </div>
    </div>
  )
}
