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
) =>
  api<Session>('POST', '/sessions', {
    name, cwd: cwd || undefined, user,
    provider, model, credentialId, apiEndpoint,
    sessionType, agentId, tools,
  })

export const updateSession = (id: string, updates: Partial<Pick<Session, 'name' | 'cwd'>>) =>
  api<Session>('PUT', `/sessions/${id}`, updates)

export const deleteSession = (id: string) =>
  api<string>('DELETE', `/sessions/${id}`)

export const fetchMessages = (id: string) =>
  api<Message[]>('GET', `/sessions/${id}/messages`)

export const clearMessages = (id: string) =>
  api<string>('POST', `/sessions/${id}/clear`)

export const stopSession = (id: string) =>
  api<string>('POST', `/sessions/${id}/stop`)

export const fetchDirs = () => api<Directory[]>('GET', '/dirs')

export const devServer = (id: string, action: 'start' | 'stop' | 'status') =>
  api<DevServerStatus>('POST', `/sessions/${id}/devserver`, { action })

export const deploy = (id: string, message: string) =>
  api<DeployResult>('POST', `/sessions/${id}/deploy`, { message })

export const fetchProviders = () => api<ProviderInfo[]>('GET', '/providers')

export const fetchCredentials = () => api<Credentials>('GET', '/credentials')

export const createCredential = (provider: string, name: string, apiKey: string) =>
  api<Credential>('POST', '/credentials', { provider, name, apiKey })

export const deleteCredential = (id: string) =>
  api<string>('DELETE', `/credentials/${id}`)
