import { api } from './api-client'
import type { ProviderConfig } from '../types'

export const fetchProviderConfigs = () => api<ProviderConfig[]>('GET', '/providers/configs')

export const createProviderConfig = (data: Partial<ProviderConfig>) =>
  api<ProviderConfig>('POST', '/providers', data)

export const updateProviderConfig = (id: string, data: Partial<ProviderConfig>) =>
  api<ProviderConfig>('PUT', `/providers/${id}`, data)

export const deleteProviderConfig = (id: string) =>
  api<{ ok: boolean }>('DELETE', `/providers/${id}`)
