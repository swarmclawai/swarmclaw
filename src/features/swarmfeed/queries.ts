import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/app/api-client'
import type {
  CreatePostInput,
  FeedType,
  SwarmFeedChannel,
  SwarmFeedFeedResponse,
  SwarmFeedNotification,
  SwarmFeedNotificationsResponse,
  SwarmFeedPost,
  SwarmFeedProfile,
  SwarmFeedSearchResponse,
  SwarmFeedSearchType,
  SwarmFeedSuggestedResponse,
} from '@/types/swarmfeed'

export const swarmFeedQueryKeys = {
  all: ['swarmfeed'] as const,
  channels: () => ['swarmfeed', 'channels'] as const,
  feed: (params: { type: FeedType; agentId?: string; channelId?: string }) => ['swarmfeed', 'feed', params] as const,
  bookmarks: (agentId: string) => ['swarmfeed', 'bookmarks', agentId] as const,
  notifications: (agentId: string) => ['swarmfeed', 'notifications', agentId] as const,
  suggested: (agentId?: string) => ['swarmfeed', 'suggested', agentId || 'public'] as const,
  search: (params: { query: string; type?: SwarmFeedSearchType }) => ['swarmfeed', 'search', params] as const,
  profile: (agentId: string, viewerAgentId?: string) => ['swarmfeed', 'profile', agentId, viewerAgentId || null] as const,
  profilePosts: (agentId: string) => ['swarmfeed', 'profile-posts', agentId] as const,
  thread: (postId: string) => ['swarmfeed', 'thread', postId] as const,
}

export async function fetchFeed(
  type: FeedType,
  params?: { agentId?: string; channelId?: string; cursor?: string; limit?: number },
): Promise<SwarmFeedFeedResponse> {
  const searchParams = new URLSearchParams()
  searchParams.set('type', type)
  if (params?.agentId) searchParams.set('agentId', params.agentId)
  if (params?.channelId) searchParams.set('channelId', params.channelId)
  if (params?.cursor) searchParams.set('cursor', params.cursor)
  if (params?.limit) searchParams.set('limit', String(params.limit))
  return api<SwarmFeedFeedResponse>('GET', `/swarmfeed?${searchParams.toString()}`)
}

export async function fetchChannels(): Promise<SwarmFeedChannel[]> {
  const result = await api<{ channels: SwarmFeedChannel[] }>('GET', '/swarmfeed/channels')
  return result.channels
}

export async function fetchBookmarks(agentId: string): Promise<SwarmFeedPost[]> {
  const result = await api<SwarmFeedFeedResponse>('GET', `/swarmfeed/bookmarks?agentId=${encodeURIComponent(agentId)}`)
  return result.posts
}

export async function fetchNotifications(agentId: string): Promise<SwarmFeedNotification[]> {
  const result = await api<SwarmFeedNotificationsResponse>('GET', `/swarmfeed/notifications?agentId=${encodeURIComponent(agentId)}`)
  return result.notifications
}

export async function fetchSuggestedFollows(agentId?: string): Promise<SwarmFeedSuggestedResponse> {
  const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''
  return api<SwarmFeedSuggestedResponse>('GET', `/swarmfeed/suggested${query}`)
}

export async function searchFeed(query: string, type?: SwarmFeedSearchType): Promise<SwarmFeedSearchResponse> {
  const params = new URLSearchParams({ q: query })
  if (type) params.set('type', type)
  return api<SwarmFeedSearchResponse>('GET', `/swarmfeed/search?${params.toString()}`)
}

export async function submitPost(
  agentId: string,
  input: CreatePostInput,
): Promise<SwarmFeedPost> {
  return api<SwarmFeedPost>('POST', '/swarmfeed/posts', {
    agentId,
    content: input.content,
    channelId: input.channelId,
    parentId: input.parentId,
    quotedPostId: input.quotedPostId,
  })
}

export async function fetchProfile(agentId: string, viewerAgentId?: string): Promise<SwarmFeedProfile> {
  const params = new URLSearchParams()
  if (viewerAgentId) params.set('viewerAgentId', viewerAgentId)
  const query = params.toString()
  return api<SwarmFeedProfile>('GET', `/swarmfeed/profiles/${encodeURIComponent(agentId)}${query ? `?${query}` : ''}`)
}

export async function fetchProfilePosts(agentId: string): Promise<SwarmFeedPost[]> {
  const result = await api<SwarmFeedFeedResponse>('GET', `/swarmfeed/profiles/${encodeURIComponent(agentId)}/posts?limit=20&filter=posts`)
  return result.posts
}

export async function fetchPostThread(postId: string): Promise<{ post: SwarmFeedPost; replies: SwarmFeedPost[] }> {
  const [post, replies] = await Promise.all([
    api<SwarmFeedPost>('GET', `/swarmfeed/posts/${encodeURIComponent(postId)}`),
    api<SwarmFeedFeedResponse>('GET', `/swarmfeed/posts/${encodeURIComponent(postId)}/replies?limit=30`),
  ])
  return { post, replies: replies.posts }
}

export async function runSwarmFeedAction(input: {
  action: 'like' | 'unlike' | 'repost' | 'unrepost' | 'bookmark' | 'unbookmark' | 'follow' | 'unfollow' | 'quote_repost'
  agentId: string
  postId?: string
  targetAgentId?: string
  content?: string
  channelId?: string
}): Promise<unknown> {
  return api('POST', '/swarmfeed/actions', input)
}

export function useSwarmFeedFeedQuery(params: { type: FeedType; agentId?: string; channelId?: string; enabled?: boolean }) {
  return useQuery<SwarmFeedFeedResponse>({
    queryKey: swarmFeedQueryKeys.feed({ type: params.type, agentId: params.agentId, channelId: params.channelId }),
    queryFn: () => fetchFeed(params.type, { agentId: params.agentId, channelId: params.channelId, limit: 50 }),
    enabled: params.enabled,
    staleTime: 15_000,
  })
}

export function useSwarmFeedChannelsQuery() {
  return useQuery<SwarmFeedChannel[]>({
    queryKey: swarmFeedQueryKeys.channels(),
    queryFn: fetchChannels,
    staleTime: 60_000,
  })
}

export function useSwarmFeedBookmarksQuery(agentId: string, enabled = true) {
  return useQuery<SwarmFeedPost[]>({
    queryKey: swarmFeedQueryKeys.bookmarks(agentId),
    queryFn: () => fetchBookmarks(agentId),
    enabled: enabled && !!agentId,
    staleTime: 15_000,
  })
}

export function useSwarmFeedNotificationsQuery(agentId: string, enabled = true) {
  return useQuery<SwarmFeedNotification[]>({
    queryKey: swarmFeedQueryKeys.notifications(agentId),
    queryFn: () => fetchNotifications(agentId),
    enabled: enabled && !!agentId,
    staleTime: 15_000,
  })
}

export function useSwarmFeedSuggestedQuery(agentId?: string, enabled = true) {
  return useQuery<SwarmFeedSuggestedResponse>({
    queryKey: swarmFeedQueryKeys.suggested(agentId),
    queryFn: () => fetchSuggestedFollows(agentId),
    enabled,
    staleTime: 30_000,
  })
}

export function useSwarmFeedSearchQuery(params: { query: string; type?: SwarmFeedSearchType; enabled?: boolean }) {
  return useQuery<SwarmFeedSearchResponse>({
    queryKey: swarmFeedQueryKeys.search({ query: params.query, type: params.type }),
    queryFn: () => searchFeed(params.query, params.type),
    enabled: params.enabled && params.query.trim().length > 0,
    staleTime: 15_000,
  })
}

export function useSwarmFeedProfileQuery(agentId: string, viewerAgentId?: string, enabled = true) {
  return useQuery<SwarmFeedProfile>({
    queryKey: swarmFeedQueryKeys.profile(agentId, viewerAgentId),
    queryFn: () => fetchProfile(agentId, viewerAgentId),
    enabled: enabled && !!agentId,
    staleTime: 20_000,
  })
}

export function useSwarmFeedProfilePostsQuery(agentId: string, enabled = true) {
  return useQuery<SwarmFeedPost[]>({
    queryKey: swarmFeedQueryKeys.profilePosts(agentId),
    queryFn: () => fetchProfilePosts(agentId),
    enabled: enabled && !!agentId,
    staleTime: 20_000,
  })
}

export function useSwarmFeedThreadQuery(postId: string, enabled = true) {
  return useQuery<{ post: SwarmFeedPost; replies: SwarmFeedPost[] }>({
    queryKey: swarmFeedQueryKeys.thread(postId),
    queryFn: () => fetchPostThread(postId),
    enabled: enabled && !!postId,
    staleTime: 10_000,
  })
}

export function useSwarmFeedPostMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ agentId, input }: { agentId: string; input: CreatePostInput }) => submitPost(agentId, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: swarmFeedQueryKeys.all })
    },
  })
}

export function useSwarmFeedActionMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: runSwarmFeedAction,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: swarmFeedQueryKeys.all })
    },
  })
}
