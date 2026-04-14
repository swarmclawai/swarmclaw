import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/app/api-client'
import {
  createProviderConfig,
  deleteProviderConfig,
  fetchProviderConfigs,
  updateProviderConfig,
} from '@/lib/provider-config'
import {
  fetchProviderModelDiscovery,
  type DiscoverProviderModelsParams,
} from '@/lib/provider-model-discovery-client'
import { fetchProviders } from '@/lib/chat/chats'
import type {
  ProviderConfig,
  ProviderInfo,
  ProviderModelDiscoveryResult,
} from '@/types'

type QueryOptions = {
  enabled?: boolean
}

interface SaveBuiltinProviderInput {
  id: string
  models: string[]
  isEnabled: boolean
  baseUrl?: string
}

interface SaveCustomProviderInput {
  id?: string | null
  data: Partial<ProviderConfig>
}

interface CheckProviderConnectionInput {
  provider: string
  credentialId?: string | null
  endpoint?: string | null
  model?: string | null
}

async function invalidateProviderQueries(queryClient: ReturnType<typeof useQueryClient>) {
  await queryClient.invalidateQueries({ queryKey: providerQueryKeys.all })
}

export const providerQueryKeys = {
  all: ['provider-resources'] as const,
  catalog: () => ['provider-resources', 'catalog'] as const,
  configs: () => ['provider-resources', 'configs'] as const,
}

export function useProvidersQuery(options: QueryOptions = {}) {
  return useQuery<ProviderInfo[]>({
    queryKey: providerQueryKeys.catalog(),
    queryFn: fetchProviders,
    enabled: options.enabled,
    staleTime: 30_000,
  })
}

export function useProviderConfigsQuery(options: QueryOptions = {}) {
  return useQuery<ProviderConfig[]>({
    queryKey: providerQueryKeys.configs(),
    queryFn: fetchProviderConfigs,
    enabled: options.enabled,
    staleTime: 30_000,
  })
}

export function useToggleProviderMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, isEnabled }: { id: string; isEnabled: boolean }) =>
      api('PUT', `/providers/${id}`, { isEnabled }),
    onSuccess: async () => {
      await invalidateProviderQueries(queryClient)
    },
  })
}

export function useSaveBuiltinProviderMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, models, isEnabled, baseUrl }: SaveBuiltinProviderInput) => {
      await api('PUT', `/providers/${id}/models`, { models })
      return api('PUT', `/providers/${id}`, {
        type: 'builtin',
        isEnabled,
        ...(baseUrl ? { baseUrl } : {}),
      })
    },
    onSuccess: async () => {
      await invalidateProviderQueries(queryClient)
    },
  })
}

export function useSaveCustomProviderMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: SaveCustomProviderInput) =>
      id ? updateProviderConfig(id, data) : createProviderConfig(data),
    onSuccess: async () => {
      await invalidateProviderQueries(queryClient)
    },
  })
}

export function useDeleteProviderMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteProviderConfig(id),
    onSuccess: async () => {
      await invalidateProviderQueries(queryClient)
    },
  })
}

export function useResetProviderModelsMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api('DELETE', `/providers/${id}/models`),
    onSuccess: async () => {
      await invalidateProviderQueries(queryClient)
    },
  })
}

export function useCheckProviderConnectionMutation() {
  return useMutation({
    mutationFn: ({ provider, credentialId, endpoint, model }: CheckProviderConnectionInput) =>
      api<{ ok: boolean; message: string }>('POST', '/setup/check-provider', {
        provider,
        credentialId,
        endpoint,
        model,
      }),
  })
}

export function useProviderModelDiscoveryMutation() {
  return useMutation<ProviderModelDiscoveryResult, Error, DiscoverProviderModelsParams>({
    mutationFn: fetchProviderModelDiscovery,
  })
}
