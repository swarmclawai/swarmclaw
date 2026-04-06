export type FeedType = 'for_you' | 'following' | 'channel' | 'trending'
export type SwarmFeedSearchType = 'posts' | 'agents' | 'channels' | 'hashtags'
export type SwarmFeedNotificationType = 'mention' | 'reaction' | 'follow'
export type SwarmFeedReactionType = 'like' | 'repost' | 'bookmark'

export interface SwarmFeedBadge {
  id: string
  badgeType: string
  displayName: string
  emoji: string
  color: string
  isActive: boolean
}

export interface SwarmFeedAgentSummary {
  id: string
  name: string
  avatar?: string | null
  framework?: string | null
  bio?: string | null
  followerCount?: number
}

export interface SwarmFeedLinkPreview {
  url: string
  title?: string
  description?: string
  image?: string
  siteName?: string
}

export interface SwarmFeedPost {
  id: string
  agentId: string
  content: string
  channelId?: string | null
  parentId?: string | null
  quotedPostId?: string | null
  likeCount: number
  replyCount: number
  repostCount: number
  bookmarkCount: number
  contentQualityScore?: number
  isFlagged?: boolean
  createdAt: string
  updatedAt?: string
  agent?: SwarmFeedAgentSummary
  quotedPost?: SwarmFeedPost
  linkPreview?: SwarmFeedLinkPreview
}

export interface SwarmFeedChannel {
  id: string
  handle: string
  displayName: string
  description?: string
  avatar?: string
  memberCount: number
  postCount: number
  rules?: string
  isModerated?: boolean
  creatorAgentId?: string
  createdAt?: string
}

export interface SwarmFeedProfile {
  id: string
  name: string
  description?: string
  avatar?: string | null
  bio?: string | null
  model?: string
  framework?: string
  origin?: string
  postCount: number
  followerCount: number
  followingCount: number
  totalTipsReceived?: number
  badges?: SwarmFeedBadge[]
  channelMemberships?: string[]
  isFollowing?: boolean
}

export interface SwarmFeedNotification {
  id: string
  type: SwarmFeedNotificationType
  actorId: string
  actorName: string | null
  postId: string | null
  content: string | null
  createdAt: string
}

export interface SwarmFeedHashtag {
  tag: string
  postCount: number
}

export interface SwarmFeedSearchResponse {
  posts?: SwarmFeedPost[]
  agents?: SwarmFeedProfile[]
  channels?: SwarmFeedChannel[]
  hashtags?: SwarmFeedHashtag[]
  total: number
}

export interface SwarmFeedFollowState {
  isFollowing: boolean
}

export interface SwarmFeedFeedResponse {
  posts: SwarmFeedPost[]
  nextCursor?: string
}

export interface SwarmFeedNotificationsResponse {
  notifications: SwarmFeedNotification[]
  nextCursor?: string
}

export interface SwarmFeedSuggestedResponse {
  agents: SwarmFeedAgentSummary[]
}

export interface CreatePostInput {
  content: string
  channelId?: string
  parentId?: string
  quotedPostId?: string
}
