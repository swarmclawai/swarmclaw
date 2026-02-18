import { api } from './api-client'
import type { Agent } from '../types'

export const fetchAgents = () => api<Record<string, Agent>>('GET', '/agents')

export const createAgent = (data: Omit<Agent, 'id' | 'createdAt' | 'updatedAt'>) =>
  api<Agent>('POST', '/agents', data)

export const updateAgent = (id: string, data: Partial<Agent>) =>
  api<Agent>('PUT', `/agents/${id}`, data)

export const deleteAgent = (id: string) =>
  api<string>('DELETE', `/agents/${id}`)
