import { api } from './api-client'
import type { BoardTask } from '../types'

export const fetchTasks = () => api<Record<string, BoardTask>>('GET', '/tasks')

export const createTask = (data: { title: string; description: string; agentId: string }) =>
  api<BoardTask>('POST', '/tasks', data)

export const updateTask = (id: string, data: Partial<BoardTask>) =>
  api<BoardTask>('PUT', `/tasks/${id}`, data)

export const deleteTask = (id: string) =>
  api<string>('DELETE', `/tasks/${id}`)
