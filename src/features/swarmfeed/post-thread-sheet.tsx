'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { PostCard } from './post-card'
import { useSwarmFeedActionMutation, useSwarmFeedPostMutation, useSwarmFeedThreadQuery } from './queries'

type Props = {
  open: boolean
  postId: string | null
  actingAgentId?: string
  channelLabels?: Record<string, string>
  initialMode?: 'reply' | 'quote'
  onClose: () => void
  onProfileOpen?: (agentId: string) => void
}

export function PostThreadSheet({
  open,
  postId,
  actingAgentId,
  channelLabels,
  initialMode = 'reply',
  onClose,
  onProfileOpen,
}: Props) {
  const threadQuery = useSwarmFeedThreadQuery(postId || '', open && !!postId)
  const postMutation = useSwarmFeedPostMutation()
  const actionMutation = useSwarmFeedActionMutation()
  const [mode, setMode] = useState<'reply' | 'quote'>(initialMode)
  const [content, setContent] = useState('')

  useEffect(() => {
    if (!open) return
    setMode(initialMode)
    setContent('')
  }, [initialMode, open, postId])

  async function submit() {
    if (!actingAgentId || !postId || !content.trim()) return
    try {
      if (mode === 'reply') {
        await postMutation.mutateAsync({
          agentId: actingAgentId,
          input: { content: content.trim(), parentId: postId },
        })
      } else {
        await actionMutation.mutateAsync({
          action: 'quote_repost',
          agentId: actingAgentId,
          postId,
          content: content.trim(),
        })
      }
      toast.success(mode === 'reply' ? 'Reply posted' : 'Quote repost published')
      setContent('')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to publish response')
    }
  }

  const post = threadQuery.data?.post
  const replies = threadQuery.data?.replies || []

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <SheetContent side="right" className="w-full border-white/[0.08] bg-bg sm:max-w-xl">
        <SheetHeader className="border-b border-white/[0.06] pb-4">
          <SheetTitle className="font-display text-[18px] font-700 text-text">Thread</SheetTitle>
          <SheetDescription className="text-[13px] text-text-3/70">
            Read the full thread, then reply or quote repost from the currently selected agent.
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4">
          <div className="flex-1 overflow-y-auto py-4">
            {threadQuery.isLoading ? (
              <div className="rounded-[16px] border border-white/[0.06] bg-surface/70 p-6 text-[13px] text-text-3/70">
                Loading thread…
              </div>
            ) : threadQuery.error ? (
              <div className="rounded-[16px] border border-red-500/20 bg-red-500/5 p-6 text-[13px] text-red-200">
                {threadQuery.error instanceof Error ? threadQuery.error.message : 'Failed to load thread'}
              </div>
            ) : post ? (
              <div className="space-y-4">
                <PostCard
                  post={post}
                  channelLabel={post.channelId ? channelLabels?.[post.channelId] : null}
                  canInteract={false}
                  onProfileOpen={onProfileOpen}
                />
                {replies.length > 0 ? (
                  <div className="space-y-3 pl-4">
                    {replies.map((reply) => (
                      <PostCard
                        key={reply.id}
                        post={reply}
                        channelLabel={reply.channelId ? channelLabels?.[reply.channelId] : null}
                        canInteract={false}
                        onProfileOpen={onProfileOpen}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-[14px] border border-white/[0.06] bg-surface/60 p-4 text-[13px] text-text-3/70">
                    No replies yet.
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div className="border-t border-white/[0.06] pt-4">
            <div className="mb-3 flex gap-2">
              {(['reply', 'quote'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setMode(option)}
                  className={`cursor-pointer rounded-[999px] border px-3 py-1.5 text-[12px] font-700 uppercase tracking-[0.08em] transition-all ${
                    mode === option
                      ? 'border-accent-bright/50 bg-accent-bright/10 text-accent-bright'
                      : 'border-white/[0.08] bg-transparent text-text-3 hover:text-text'
                  }`}
                >
                  {option === 'reply' ? 'Reply' : 'Quote'}
                </button>
              ))}
            </div>
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder={mode === 'reply' ? 'Write a concise reply…' : 'Add your commentary before reposting…'}
              className="min-h-[110px] w-full resize-y rounded-[14px] border border-white/[0.08] bg-surface/70 px-4 py-3 text-[14px] text-text outline-none focus-glow"
              maxLength={2000}
            />
            <div className="mt-3 flex items-center justify-between">
              <span className="text-[11px] text-text-3/55">{content.length}/2000</span>
              <button
                type="button"
                onClick={() => { void submit() }}
                disabled={!actingAgentId || !content.trim() || postMutation.isPending || actionMutation.isPending}
                className="cursor-pointer rounded-[12px] bg-accent-bright px-4 py-2.5 text-[13px] font-700 text-white transition-all hover:bg-accent-bright/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {mode === 'reply' ? 'Reply' : 'Quote repost'}
              </button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
