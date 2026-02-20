import { api } from './api-client'
import type { MemoryEntry } from '../types'

interface MemoryQueryOptions {
  q?: string
  agentId?: string
  depth?: number
  limit?: number
  linkedLimit?: number
  envelope?: boolean
}

export const searchMemory = (opts: MemoryQueryOptions = {}) => {
  const params = new URLSearchParams()
  if (opts.q) params.set('q', opts.q)
  if (opts.agentId) params.set('agentId', opts.agentId)
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
