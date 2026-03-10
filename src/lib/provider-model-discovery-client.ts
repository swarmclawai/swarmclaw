import { api } from './app/api-client'
import type { ProviderModelDiscoveryResult } from '@/types'

export interface DiscoverProviderModelsParams {
  providerId: string
  credentialId?: string | null
  endpoint?: string | null
  force?: boolean
  requiresApiKey?: boolean
}

export function buildProviderModelDiscoveryPath(params: DiscoverProviderModelsParams): string {
  const searchParams = new URLSearchParams()
  if (params.credentialId) searchParams.set('credentialId', params.credentialId)
  if (params.endpoint?.trim()) searchParams.set('endpoint', params.endpoint.trim())
  if (params.force) searchParams.set('force', '1')
  if (typeof params.requiresApiKey === 'boolean') {
    searchParams.set('requiresApiKey', params.requiresApiKey ? '1' : '0')
  }
  const query = searchParams.toString()
  const encodedProviderId = encodeURIComponent(params.providerId)
  return `/providers/${encodedProviderId}/discover-models${query ? `?${query}` : ''}`
}

export function fetchProviderModelDiscovery(
  params: DiscoverProviderModelsParams,
): Promise<ProviderModelDiscoveryResult> {
  return api<ProviderModelDiscoveryResult>('GET', buildProviderModelDiscoveryPath(params))
}
