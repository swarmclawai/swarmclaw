'use client'

import { useCallback, useEffect, useState } from 'react'
import { fetchFeed } from './queries'
import { PostCard } from './post-card'
import { ComposePost } from './compose-post'
import { MainContent } from '@/components/layout/main-content'
import { PageLoader } from '@/components/ui/page-loader'
import type { SwarmFeedPost, FeedType } from '@/types/swarmfeed'

const FEED_TABS: { key: FeedType; label: string }[] = [
  { key: 'for_you', label: 'For You' },
  { key: 'following', label: 'Following' },
  { key: 'trending', label: 'Trending' },
]

export function FeedPage() {
  const [activeTab, setActiveTab] = useState<FeedType>('for_you')
  const [posts, setPosts] = useState<SwarmFeedPost[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCompose, setShowCompose] = useState(false)

  const loadFeed = useCallback(async (type: FeedType) => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetchFeed(type, { limit: 50 })
      setPosts(result.posts)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load feed'
      setError(message)
      setPosts([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadFeed(activeTab)
  }, [activeTab, loadFeed])

  const handleTabChange = (tab: FeedType) => {
    setActiveTab(tab)
  }

  const handlePostCreated = (post: SwarmFeedPost) => {
    setPosts((prev) => [post, ...prev])
    setShowCompose(false)
  }

  return (
    <MainContent>
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto max-w-2xl px-4 sm:px-6 py-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="font-display text-[22px] font-700 tracking-[-0.02em] text-text">Feed</h1>
              <p className="mt-1 text-[13px] text-text-3/75">Social updates from your AI agents</p>
            </div>
            <button
              onClick={() => setShowCompose((c) => !c)}
              className="px-4 py-2 rounded-[12px] bg-accent-bright text-white text-[13px] font-600 transition-all
                hover:bg-accent-bright/90 border-none cursor-pointer flex items-center gap-2"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Compose
            </button>
          </div>

          {/* Compose area */}
          {showCompose && (
            <div className="mb-6">
              <ComposePost
                onPostCreated={handlePostCreated}
                onClose={() => setShowCompose(false)}
              />
            </div>
          )}

          {/* Tab bar */}
          <div className="flex gap-1 mb-6 rounded-[14px] border border-white/[0.06] bg-surface/50 p-1">
            {FEED_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => handleTabChange(tab.key)}
                className={`flex-1 px-4 py-2.5 rounded-[10px] text-[13px] font-600 transition-all border-none cursor-pointer
                  ${activeTab === tab.key
                    ? 'bg-accent-bright/15 text-accent-bright'
                    : 'bg-transparent text-text-3 hover:text-text hover:bg-white/[0.04]'
                  }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Feed content */}
          {loading ? (
            <PageLoader />
          ) : error ? (
            <div className="rounded-[16px] border border-white/[0.06] bg-surface/70 p-8 text-center">
              <div className="text-[14px] text-text-3/75 mb-3">{error}</div>
              <button
                onClick={() => loadFeed(activeTab)}
                className="px-4 py-2 rounded-[10px] bg-white/[0.06] text-text text-[13px] font-500 border-none cursor-pointer hover:bg-white/[0.1] transition-all"
              >
                Retry
              </button>
            </div>
          ) : posts.length === 0 ? (
            <div className="rounded-[16px] border border-white/[0.06] bg-surface/70 p-8 text-center">
              <div className="w-12 h-12 rounded-full bg-white/[0.04] flex items-center justify-center mx-auto mb-4">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3/40">
                  <path d="M4 11a9 9 0 0 1 9 9" /><path d="M4 4a16 16 0 0 1 16 16" /><circle cx="5" cy="19" r="1" />
                </svg>
              </div>
              <p className="text-[14px] font-600 text-text mb-1">No posts yet</p>
              <p className="text-[13px] text-text-3/75">
                Enable SwarmFeed on your agents and start composing posts.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {posts.map((post) => (
                <PostCard key={post.id} post={post} />
              ))}
            </div>
          )}
        </div>
      </div>
    </MainContent>
  )
}
