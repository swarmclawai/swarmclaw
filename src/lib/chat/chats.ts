import { api } from '@/lib/app/api-client'
import type {
  Sessions, Session, Message, Directory, DevServerStatus, DeployResult,
  ProviderInfo, Credential, Credentials, ProviderType, SessionQueueSnapshot, SessionType,
} from '@/types'

export const fetchChats = () => api<Sessions>('GET', '/chats')
/** @deprecated Use fetchChats */
export const fetchSessions = fetchChats

export const fetchChat = (id: string) =>
  api<Session>('GET', `/chats/${id}`)

export const createChat = (
  name: string,
  cwd: string,
  user: string,
  provider?: ProviderType,
  model?: string,
  credentialId?: string | null,
  apiEndpoint?: string | null,
  sessionType?: SessionType,
  agentId?: string | null,
  tools?: string[],
  extensions?: string[],
  file?: string | null,
) =>
  api<Session>('POST', '/chats', {
    name, cwd: cwd || undefined, user,
    provider, model, credentialId, apiEndpoint,
    sessionType, agentId, tools, extensions, file: file || undefined,
  })
/** @deprecated Use createChat */
export const createSession = createChat

export const updateChat = (id: string, updates: Partial<Pick<Session, 'name' | 'cwd'>>) =>
  api<Session>('PUT', `/chats/${id}`, updates)
/** @deprecated Use updateChat */
export const updateSession = updateChat

export const deleteChat = (id: string) =>
  api<string>('DELETE', `/chats/${id}`)
/** @deprecated Use deleteChat */
export const deleteSession = deleteChat

export const fetchMessages = (id: string) =>
  api<Message[]>('GET', `/chats/${id}/messages`)

export interface PaginatedMessages {
  messages: Message[]
  total: number
  hasMore: boolean
  startIndex: number
}

export const fetchMessagesPaginated = (id: string, limit: number = 100) =>
  api<PaginatedMessages>('GET', `/chats/${id}/messages?limit=${limit}`)

export interface QueueMessageInput {
  message: string
  imagePath?: string
  imageUrl?: string
  attachedFiles?: string[]
  replyToId?: string
}

export const fetchSessionQueue = (id: string) =>
  api<SessionQueueSnapshot>('GET', `/chats/${id}/queue`)

export const enqueueSessionQueueMessage = (id: string, body: QueueMessageInput) =>
  api<{ queued: { runId: string; position: number }; snapshot: SessionQueueSnapshot }>('POST', `/chats/${id}/queue`, body)

export const removeQueuedSessionMessage = (id: string, runId: string) =>
  api<{ cancelled: number; snapshot: SessionQueueSnapshot }>('DELETE', `/chats/${id}/queue`, { runId })

export const clearSessionQueue = (id: string) =>
  api<{ cancelled: number; snapshot: SessionQueueSnapshot }>('DELETE', `/chats/${id}/queue`, {})

export interface ClearChatResult {
  cleared: number
  undoToken: string
  expiresAt: number
}

export const clearMessages = (id: string) =>
  api<ClearChatResult>('POST', `/chats/${id}/clear`)

export const undoClearMessages = (id: string, undoToken: string) =>
  api<{ restored: number }>('POST', `/chats/${id}/clear/undo`, { undoToken })

export interface ContextStatusResponse {
  estimatedTokens: number
  effectiveTokens: number
  contextWindow: number
  percentUsed: number
  messageCount: number
  extraTokens: number
  reserveTokens: number
  remainingTokens: number
  strategy: 'ok' | 'warning' | 'critical'
}

export const fetchContextStatus = (id: string) =>
  api<ContextStatusResponse>('GET', `/chats/${id}/context-status`)

export interface CompactChatResult {
  status: 'compacted' | 'no_action'
  prunedCount?: number
  memoriesStored?: number
  summaryAdded?: boolean
  messageCount: number
  keepLastN?: number
}

export const compactChat = (id: string, keepLastN?: number) =>
  api<CompactChatResult>('POST', `/chats/${id}/compact`, keepLastN ? { keepLastN } : {})

export const stopChat = (id: string) =>
  api<string>('POST', `/chats/${id}/stop`)
/** @deprecated Use stopChat */
export const stopSession = stopChat

export const fetchDirs = async () => {
  const data = await api<{ dirs: Directory[] }>('GET', '/dirs')
  return data.dirs
}

export const devServer = (id: string, action: 'start' | 'stop' | 'status') =>
  api<DevServerStatus>('POST', `/chats/${id}/devserver`, { action })

export const checkBrowser = (id: string) =>
  api<{ active: boolean }>('GET', `/chats/${id}/browser`)

export const stopBrowser = (id: string) =>
  api<string>('DELETE', `/chats/${id}/browser`)

export const deploy = (id: string, message: string) =>
  api<DeployResult>('POST', `/chats/${id}/deploy`, { message })

export const fetchProviders = () => api<ProviderInfo[]>('GET', '/providers')

export const fetchCredentials = () => api<Credentials>('GET', '/credentials')

export const createCredential = (provider: string, name: string, apiKey: string) =>
  api<Credential>('POST', '/credentials', { provider, name, apiKey })

export const deleteCredential = (id: string) =>
  api<string>('DELETE', `/credentials/${id}`)
