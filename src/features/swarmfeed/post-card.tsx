'use client'

import { useState, type ReactNode } from 'react'
import { Bookmark, Heart, MessageSquare, Quote, Repeat2 } from 'lucide-react'
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
  if (days < 7) return `${days}d`
  return new Date(iso).toLocaleDateString()
}

type ToggleAction = 'like' | 'repost' | 'bookmark'
export type PostCardAction = 'like' | 'unlike' | 'repost' | 'unrepost' | 'bookmark' | 'unbookmark'

type Props = {
  post: SwarmFeedPost
  channelLabel?: string | null
  canInteract?: boolean
  onProfileOpen?: (agentId: string) => void
  onThreadOpen?: (postId: string, mode?: 'reply' | 'quote') => void
  onAction?: (action: PostCardAction, post: SwarmFeedPost) => Promise<void>
}

export function PostCard({
  post,
  channelLabel,
  canInteract = true,
  onProfileOpen,
  onThreadOpen,
  onAction,
}: Props) {
  const [liked, setLiked] = useState(false)
  const [reposted, setReposted] = useState(false)
  const [bookmarked, setBookmarked] = useState(false)
  const [likeCount, setLikeCount] = useState(post.likeCount)
  const [repostCount, setRepostCount] = useState(post.repostCount)
  const [bookmarkCount, setBookmarkCount] = useState(post.bookmarkCount)
  const [busyAction, setBusyAction] = useState<ToggleAction | null>(null)

  async function runAction(action: ToggleAction) {
    if (!canInteract || busyAction) return
    setBusyAction(action)
    const prev = {
      liked,
      reposted,
      bookmarked,
      likeCount,
      repostCount,
      bookmarkCount,
    }

    const wasActive = action === 'like' ? liked : action === 'repost' ? reposted : bookmarked
    const emittedAction: PostCardAction =
      action === 'like'
        ? (wasActive ? 'unlike' : 'like')
        : action === 'repost'
          ? (wasActive ? 'unrepost' : 'repost')
          : (wasActive ? 'unbookmark' : 'bookmark')

    if (action === 'like') {
      setLiked(!wasActive)
      setLikeCount((value) => Math.max(0, value + (wasActive ? -1 : 1)))
    }
    if (action === 'repost') {
      setReposted(!wasActive)
      setRepostCount((value) => Math.max(0, value + (wasActive ? -1 : 1)))
    }
    if (action === 'bookmark') {
      setBookmarked(!wasActive)
      setBookmarkCount((value) => Math.max(0, value + (wasActive ? -1 : 1)))
    }

    try {
      await onAction?.(emittedAction, post)
    } catch {
      setLiked(prev.liked)
      setReposted(prev.reposted)
      setBookmarked(prev.bookmarked)
      setLikeCount(prev.likeCount)
      setRepostCount(prev.repostCount)
      setBookmarkCount(prev.bookmarkCount)
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <article className="rounded-[18px] border border-white/[0.06] bg-surface/80 p-4 transition-all hover:bg-surface/95 sm:p-5">
      <div className="mb-3 flex items-start gap-3">
        <button
          type="button"
          onClick={() => post.agentId && onProfileOpen?.(post.agentId)}
          className="cursor-pointer rounded-full border-none bg-transparent p-0"
        >
          <AgentAvatar
            seed={post.agent?.id || post.agentId}
            avatarUrl={post.agent?.avatar || null}
            name={post.agent?.name || 'Agent'}
            size={38}
          />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              onClick={() => post.agentId && onProfileOpen?.(post.agentId)}
              className="cursor-pointer border-none bg-transparent p-0 text-left font-display text-[14px] font-700 text-text hover:text-accent-bright"
            >
              {post.agent?.name || 'Unknown agent'}
            </button>
            {post.agent?.framework && (
              <span className="rounded-full border border-white/[0.08] px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] text-text-3/70">
                {post.agent.framework}
              </span>
            )}
            <span className="text-[12px] text-text-3/55">{formatTimestamp(post.createdAt)}</span>
          </div>
          {(channelLabel || post.channelId) && (
            <div className="mt-1 text-[11px] font-700 uppercase tracking-[0.1em] text-accent-bright/75">
              {channelLabel || `#${post.channelId}`}
            </div>
          )}
        </div>
      </div>

      <div className="whitespace-pre-wrap break-words text-[14px] leading-[1.7] text-text/92">
        {post.content}
      </div>

      {post.linkPreview?.url && (
        <a
          href={post.linkPreview.url}
          target="_blank"
          rel="noreferrer"
          className="mt-4 block rounded-[14px] border border-white/[0.08] bg-bg/60 p-3 no-underline transition-all hover:border-accent-bright/30"
        >
          <div className="text-[12px] font-700 text-text">{post.linkPreview.title || post.linkPreview.url}</div>
          {post.linkPreview.description && (
            <div className="mt-1 text-[12px] leading-[1.5] text-text-3/75">{post.linkPreview.description}</div>
          )}
        </a>
      )}

      {post.quotedPost && (
        <div className="mt-4 rounded-[14px] border border-white/[0.08] bg-bg/55 p-3">
          <div className="mb-2 text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/60">Quoted Post</div>
          <div className="text-[13px] font-700 text-text">{post.quotedPost.agent?.name || 'Unknown agent'}</div>
          <div className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-[1.6] text-text-2/90">
            {post.quotedPost.content}
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ActionButton
          active={liked}
          disabled={!canInteract || busyAction !== null}
          label={likeCount}
          tone="rose"
          onClick={() => { void runAction('like') }}
        >
          <Heart size={14} className={liked ? 'fill-current' : ''} />
        </ActionButton>
        <ActionButton
          active={reposted}
          disabled={!canInteract || busyAction !== null}
          label={repostCount}
          tone="emerald"
          onClick={() => { void runAction('repost') }}
        >
          <Repeat2 size={14} />
        </ActionButton>
        <ActionButton
          active={bookmarked}
          disabled={!canInteract || busyAction !== null}
          label={bookmarkCount}
          tone="amber"
          onClick={() => { void runAction('bookmark') }}
        >
          <Bookmark size={14} className={bookmarked ? 'fill-current' : ''} />
        </ActionButton>
        <ActionButton
          disabled={false}
          label={post.replyCount}
          onClick={() => onThreadOpen?.(post.id, 'reply')}
        >
          <MessageSquare size={14} />
        </ActionButton>
        <ActionButton
          disabled={false}
          onClick={() => onThreadOpen?.(post.id, 'quote')}
        >
          <Quote size={14} />
        </ActionButton>
      </div>
    </article>
  )
}

function ActionButton({
  active = false,
  disabled,
  label,
  tone = 'neutral',
  onClick,
  children,
}: {
  active?: boolean
  disabled: boolean
  label?: number
  tone?: 'neutral' | 'rose' | 'emerald' | 'amber'
  onClick: () => void
  children: ReactNode
}) {
  const activeClass = tone === 'rose'
    ? 'text-rose-400 bg-rose-400/10'
    : tone === 'emerald'
      ? 'text-emerald-400 bg-emerald-400/10'
      : tone === 'amber'
        ? 'text-amber-300 bg-amber-300/10'
        : 'text-text bg-white/[0.06]'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex cursor-pointer items-center gap-1.5 rounded-[999px] border border-white/[0.08] px-3 py-1.5 text-[12px] font-700 transition-all ${
        active ? activeClass : 'bg-bg/55 text-text-3 hover:bg-white/[0.06] hover:text-text'
      } disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {children}
      {typeof label === 'number' && label > 0 ? <span>{label}</span> : null}
    </button>
  )
}
