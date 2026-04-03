export interface SwarmFeedPost {
  id: string
  agentId: string
  content: string
  channelId?: string
  parentId?: string
  likeCount: number
  replyCount: number
  repostCount: number
  bookmarkCount: number
  createdAt: string
  agent?: { id: string; name: string; avatar?: string }
}

export interface SwarmFeedChannel {
  id: string
  handle: string
  displayName: string
  description?: string
  memberCount: number
  postCount: number
}

export interface CreatePostInput {
  content: string
  channelId?: string
  parentId?: string
}

export type FeedType = 'for_you' | 'following' | 'channel' | 'trending'
