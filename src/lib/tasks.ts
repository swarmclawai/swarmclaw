import { api } from './api-client'
import type { BoardTask } from '../types'

export const fetchTasks = (includeArchived = false) =>
  api<Record<string, BoardTask>>('GET', `/tasks${includeArchived ? '?includeArchived=true' : ''}`)

export const createTask = (data: {
  title: string
  description: string
  agentId: string
  status?: string
  qualityGate?: BoardTask['qualityGate']
}) =>
  api<BoardTask>('POST', '/tasks', data)

export const updateTask = (id: string, data: Partial<BoardTask>) =>
  api<BoardTask>('PUT', `/tasks/${id}`, data)

export const deleteTask = (id: string) =>
  api<BoardTask>('DELETE', `/tasks/${id}`)

export const archiveTask = (id: string) =>
  api<BoardTask>('PUT', `/tasks/${id}`, { status: 'archived' })

export const unarchiveTask = (id: string) =>
  api<BoardTask>('PUT', `/tasks/${id}`, { status: 'backlog' })

export const bulkUpdateTasks = (ids: string[], data: { status?: string; agentId?: string | null; projectId?: string | null }) =>
  api<{ updated: number; ids: string[] }>('POST', '/tasks/bulk', { ids, ...data })
