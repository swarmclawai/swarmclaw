import { api } from './app/api-client'
import type { MemoryEntry } from '../types'

interface MemoryQueryOptions {
  q?: string
  agentId?: string
  scope?: 'auto' | 'all' | 'global' | 'shared' | 'agent' | 'session' | 'project'
  scopeSessionId?: string
  projectRoot?: string
  rerank?: 'balanced' | 'semantic' | 'lexical'
  depth?: number
  limit?: number
  linkedLimit?: number
  envelope?: boolean
}

export const searchMemory = (opts: MemoryQueryOptions = {}) => {
  const params = new URLSearchParams()
  if (opts.q) params.set('q', opts.q)
  if (opts.agentId) params.set('agentId', opts.agentId)
  if (opts.scope) params.set('scope', opts.scope)
  if (opts.scopeSessionId) params.set('scopeSessionId', opts.scopeSessionId)
  if (opts.projectRoot) params.set('projectRoot', opts.projectRoot)
  if (opts.rerank) params.set('rerank', opts.rerank)
  if (typeof opts.depth === 'number') params.set('depth', String(opts.depth))
  if (typeof opts.limit === 'number') params.set('limit', String(opts.limit))
  if (typeof opts.linkedLimit === 'number') params.set('linkedLimit', String(opts.linkedLimit))
  if (opts.envelope) params.set('envelope', 'true')
  const qs = params.toString()
  return api<MemoryEntry[]>('GET', `/memory${qs ? '?' + qs : ''}`)
}

export const getMemory = (id: string, opts: Omit<MemoryQueryOptions, 'q' | 'agentId'> = {}) => {
  const params = new URLSearchParams()
  if (typeof opts.depth === 'number') params.set('depth', String(opts.depth))
  if (typeof opts.limit === 'number') params.set('limit', String(opts.limit))
  if (typeof opts.linkedLimit === 'number') params.set('linkedLimit', String(opts.linkedLimit))
  if (opts.envelope) params.set('envelope', 'true')
  const qs = params.toString()
  return api<MemoryEntry | MemoryEntry[]>('GET', `/memory/${id}${qs ? '?' + qs : ''}`)
}

export const createMemory = (data: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>) =>
  api<MemoryEntry>('POST', '/memory', data)

export const updateMemory = (id: string, data: Partial<MemoryEntry>) =>
  api<MemoryEntry>('PUT', `/memory/${id}`, data)

export const deleteMemory = (id: string) =>
  api<string>('DELETE', `/memory/${id}`)

export const getMemoryCounts = () =>
  api<Record<string, number>>('GET', '/memory?counts=true')
