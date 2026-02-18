import { api } from './api-client'
import type { MemoryEntry } from '../types'

export const searchMemory = (q?: string, agentId?: string) => {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (agentId) params.set('agentId', agentId)
  const qs = params.toString()
  return api<MemoryEntry[]>('GET', `/memory${qs ? '?' + qs : ''}`)
}

export const createMemory = (data: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>) =>
  api<MemoryEntry>('POST', '/memory', data)

export const updateMemory = (id: string, data: Partial<MemoryEntry>) =>
  api<MemoryEntry>('PUT', `/memory/${id}`, data)

export const deleteMemory = (id: string) =>
  api<string>('DELETE', `/memory/${id}`)
