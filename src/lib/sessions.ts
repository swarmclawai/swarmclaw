import { api } from './api-client'
import type {
  Sessions, Session, Message, Directory, DevServerStatus, DeployResult,
  ProviderInfo, Credential, Credentials, ProviderType, SessionType,
} from '../types'

export const fetchSessions = () => api<Sessions>('GET', '/sessions')

export const createSession = (
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
  file?: string | null,
) =>
  api<Session>('POST', '/sessions', {
    name, cwd: cwd || undefined, user,
    provider, model, credentialId, apiEndpoint,
    sessionType, agentId, tools, file: file || undefined,
  })

export const updateSession = (id: string, updates: Partial<Pick<Session, 'name' | 'cwd'>>) =>
  api<Session>('PUT', `/sessions/${id}`, updates)

export const deleteSession = (id: string) =>
  api<string>('DELETE', `/sessions/${id}`)

export const fetchMessages = (id: string) =>
  api<Message[]>('GET', `/sessions/${id}/messages`)

export interface PaginatedMessages {
  messages: Message[]
  total: number
  hasMore: boolean
  startIndex: number
}

export const fetchMessagesPaginated = (id: string, limit: number = 100) =>
  api<PaginatedMessages>('GET', `/sessions/${id}/messages?limit=${limit}`)

export const clearMessages = (id: string) =>
  api<string>('POST', `/sessions/${id}/clear`)

export const stopSession = (id: string) =>
  api<string>('POST', `/sessions/${id}/stop`)

export const fetchDirs = async () => {
  const data = await api<{ dirs: Directory[] }>('GET', '/dirs')
  return data.dirs
}

export const devServer = (id: string, action: 'start' | 'stop' | 'status') =>
  api<DevServerStatus>('POST', `/sessions/${id}/devserver`, { action })

export const checkBrowser = (id: string) =>
  api<{ active: boolean }>('GET', `/sessions/${id}/browser`)

export const stopBrowser = (id: string) =>
  api<string>('DELETE', `/sessions/${id}/browser`)

export const deploy = (id: string, message: string) =>
  api<DeployResult>('POST', `/sessions/${id}/deploy`, { message })

export const fetchProviders = () => api<ProviderInfo[]>('GET', '/providers')

export const fetchCredentials = () => api<Credentials>('GET', '/credentials')

export const createCredential = (provider: string, name: string, apiKey: string) =>
  api<Credential>('POST', '/credentials', { provider, name, apiKey })

export const deleteCredential = (id: string) =>
  api<string>('DELETE', `/credentials/${id}`)
