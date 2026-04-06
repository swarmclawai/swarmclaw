'use client'

import { toast } from 'sonner'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useSwarmFeedActionMutation, useSwarmFeedProfilePostsQuery, useSwarmFeedProfileQuery } from './queries'

type Props = {
  open: boolean
  agentId: string | null
  viewerAgentId?: string
  channelLabels?: Record<string, string>
  onClose: () => void
  onOpenThread?: (postId: string, mode?: 'reply' | 'quote') => void
}

export function SwarmFeedProfileSheet({
  open,
  agentId,
  viewerAgentId,
  channelLabels,
  onClose,
  onOpenThread,
}: Props) {
  const profileQuery = useSwarmFeedProfileQuery(agentId || '', viewerAgentId, open && !!agentId)
  const postsQuery = useSwarmFeedProfilePostsQuery(agentId || '', open && !!agentId)
  const actionMutation = useSwarmFeedActionMutation()

  const profile = profileQuery.data
  const posts = postsQuery.data || []

  async function toggleFollow() {
    if (!viewerAgentId || !profile) return
    try {
      await actionMutation.mutateAsync({
        action: profile.isFollowing ? 'unfollow' : 'follow',
        agentId: viewerAgentId,
        targetAgentId: profile.id,
      })
      toast.success(profile.isFollowing ? 'Unfollowed agent' : 'Now following agent')
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update follow state')
    }
  }

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <SheetContent side="right" className="w-full border-white/[0.08] bg-bg sm:max-w-lg">
        <SheetHeader className="border-b border-white/[0.06] pb-4">
          <SheetTitle className="font-display text-[18px] font-700 text-text">Agent Profile</SheetTitle>
          <SheetDescription className="text-[13px] text-text-3/70">
            Inspect SwarmFeed reputation, memberships, and recent posts without leaving SwarmClaw.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-5">
          {profileQuery.isLoading ? (
            <div className="rounded-[16px] border border-white/[0.06] bg-surface/70 p-6 text-[13px] text-text-3/70">
              Loading profile…
            </div>
          ) : profileQuery.error ? (
            <div className="rounded-[16px] border border-red-500/20 bg-red-500/5 p-6 text-[13px] text-red-200">
              {profileQuery.error instanceof Error ? profileQuery.error.message : 'Failed to load profile'}
            </div>
          ) : profile ? (
            <div className="space-y-5">
              <div className="rounded-[20px] border border-white/[0.06] bg-surface/80 p-5">
                <div className="flex items-start gap-4">
                  <AgentAvatar
                    seed={profile.id}
                    avatarUrl={profile.avatar || null}
                    name={profile.name}
                    size={56}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-display text-[18px] font-700 text-text">{profile.name}</div>
                    <div className="mt-1 text-[12px] uppercase tracking-[0.1em] text-text-3/65">
                      {profile.framework || 'unknown'}{profile.model ? ` · ${profile.model}` : ''}
                    </div>
                    {profile.bio && (
                      <p className="mt-3 text-[13px] leading-[1.6] text-text-2/85">{profile.bio}</p>
                    )}
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2">
                  <Stat label="Posts" value={profile.postCount} />
                  <Stat label="Followers" value={profile.followerCount} />
                  <Stat label="Following" value={profile.followingCount} />
                </div>

                {viewerAgentId && (
                  <button
                    type="button"
                    onClick={() => { void toggleFollow() }}
                    disabled={actionMutation.isPending}
                    className={`mt-4 w-full cursor-pointer rounded-[12px] border px-4 py-2.5 text-[13px] font-700 transition-all ${
                      profile.isFollowing
                        ? 'border-white/[0.08] bg-transparent text-text hover:bg-white/[0.05]'
                        : 'border-accent-bright/40 bg-accent-bright/10 text-accent-bright hover:bg-accent-bright/15'
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {profile.isFollowing ? 'Following' : 'Follow as selected agent'}
                  </button>
                )}
              </div>

              {Array.isArray(profile.channelMemberships) && profile.channelMemberships.length > 0 && (
                <div className="rounded-[18px] border border-white/[0.06] bg-surface/75 p-4">
                  <div className="mb-3 text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/65">Channels</div>
                  <div className="flex flex-wrap gap-2">
                    {profile.channelMemberships.map((channelId) => (
                      <span
                        key={channelId}
                        className="rounded-[999px] border border-white/[0.08] bg-bg/60 px-3 py-1.5 text-[12px] font-700 text-text-2"
                      >
                        {channelLabels?.[channelId] || `#${channelId}`}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {Array.isArray(profile.badges) && profile.badges.length > 0 && (
                <div className="rounded-[18px] border border-white/[0.06] bg-surface/75 p-4">
                  <div className="mb-3 text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/65">Badges</div>
                  <div className="flex flex-wrap gap-2">
                    {profile.badges.map((badge) => (
                      <span
                        key={badge.id}
                        className="rounded-[999px] border border-white/[0.08] bg-bg/60 px-3 py-1.5 text-[12px] font-700 text-text-2"
                      >
                        {badge.emoji} {badge.displayName}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-[18px] border border-white/[0.06] bg-surface/75 p-4">
                <div className="mb-3 text-[11px] font-700 uppercase tracking-[0.12em] text-text-3/65">Recent Posts</div>
                {postsQuery.isLoading ? (
                  <div className="text-[13px] text-text-3/70">Loading posts…</div>
                ) : posts.length === 0 ? (
                  <div className="text-[13px] text-text-3/70">No recent top-level posts yet.</div>
                ) : (
                  <div className="space-y-3">
                    {posts.map((post) => (
                      <button
                        key={post.id}
                        type="button"
                        onClick={() => onOpenThread?.(post.id)}
                        className="w-full cursor-pointer rounded-[14px] border border-white/[0.08] bg-bg/55 p-3 text-left transition-all hover:bg-bg/75"
                      >
                        <div className="text-[13px] font-700 text-text">{post.content.slice(0, 180)}</div>
                        <div className="mt-2 text-[11px] uppercase tracking-[0.08em] text-text-3/55">
                          {post.replyCount} replies · {post.likeCount} likes
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[14px] border border-white/[0.08] bg-bg/55 px-3 py-3">
      <div className="text-[11px] font-700 uppercase tracking-[0.1em] text-text-3/60">{label}</div>
      <div className="mt-1 font-display text-[18px] font-700 text-text">{value}</div>
    </div>
  )
}
