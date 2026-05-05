import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/app/api-client'
import { credentialQueryKeys } from '@/features/credentials/queries'
import type {
  GatewayProfile,
  OpenClawEnvironmentSummary,
  OpenClawDevicePairRequest,
  OpenClawGatewayFleetTopology,
  OpenClawGatewayPresenceEntry,
  OpenClawGatewayRpcError,
  OpenClawGatewaySession,
  OpenClawGatewayTopology,
  OpenClawNode,
  OpenClawNodePairRequest,
  OpenClawPairedDevice,
} from '@/types'

type QueryOptions = {
  enabled?: boolean
}

export interface GatewayDiscoveryResult {
  host: string
  port: number
  healthy: boolean
  models?: string[]
  error?: string
}

export interface GatewayRpcResponse<T> {
  ok?: boolean
  result?: T
  error?: string
}

interface SaveGatewayProfileInput {
  id?: string | null
  payload: Record<string, unknown>
}

interface VerifyOpenClawDeployInput {
  endpoint: string
  token?: string
}

export interface VerifyOpenClawDeployResult {
  ok: boolean
  verify?: {
    ok: boolean
    message?: string
    error?: string
    hint?: string
    models?: string[]
  }
}

export interface RefreshGatewayTopologyResult {
  nodes: OpenClawNode[]
  nodePairings: OpenClawNodePairRequest[]
  devicePairings: OpenClawDevicePairRequest[]
  pairedDevices: OpenClawPairedDevice[]
  sessions: OpenClawGatewaySession[]
  presence: OpenClawGatewayPresenceEntry[]
  environments: OpenClawEnvironmentSummary[]
  errors: OpenClawGatewayRpcError[]
  topology: OpenClawGatewayTopology
}

async function invalidateGatewayQueries(queryClient: ReturnType<typeof useQueryClient>) {
  await queryClient.invalidateQueries({ queryKey: gatewayQueryKeys.all })
}

export const gatewayQueryKeys = {
  all: ['gateways'] as const,
  profiles: () => ['gateways', 'profiles'] as const,
  fleet: () => ['gateways', 'fleet'] as const,
  topology: (id: string) => ['gateways', 'topology', id] as const,
}

export function useGatewayProfilesQuery(options: QueryOptions = {}) {
  return useQuery<GatewayProfile[]>({
    queryKey: gatewayQueryKeys.profiles(),
    queryFn: () => api<GatewayProfile[]>('GET', '/gateways'),
    enabled: options.enabled,
    staleTime: 20_000,
  })
}

export function useSaveGatewayProfileMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: SaveGatewayProfileInput) =>
      id ? api('PUT', `/gateways/${id}`, payload) : api('POST', '/gateways', payload),
    onSuccess: async () => {
      await Promise.all([
        invalidateGatewayQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: credentialQueryKeys.all }),
      ])
    },
  })
}

export function useDeleteGatewayProfileMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api('DELETE', `/gateways/${id}`),
    onSuccess: async () => {
      await invalidateGatewayQueries(queryClient)
    },
  })
}

export function useCloneGatewayProfileMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) => api('POST', '/gateways', payload),
    onSuccess: async () => {
      await invalidateGatewayQueries(queryClient)
    },
  })
}

export function useGatewayHealthCheckMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api('GET', `/gateways/${id}/health`),
    onSuccess: async () => {
      await invalidateGatewayQueries(queryClient)
    },
  })
}

export function useGatewayFleetTopologyQuery(options: QueryOptions = {}) {
  return useQuery<OpenClawGatewayFleetTopology>({
    queryKey: gatewayQueryKeys.fleet(),
    queryFn: () => api<OpenClawGatewayFleetTopology>('GET', '/gateways/fleet'),
    enabled: options.enabled,
    staleTime: 30_000,
  })
}

export function useVerifyOpenClawDeployMutation() {
  return useMutation<VerifyOpenClawDeployResult, Error, VerifyOpenClawDeployInput>({
    mutationFn: ({ endpoint, token }) =>
      api<VerifyOpenClawDeployResult>('POST', '/openclaw/deploy', {
        action: 'verify',
        endpoint,
        token: token?.trim() || undefined,
      }),
  })
}

export function useCheckOpenClawGatewayMutation() {
  return useMutation({
    mutationFn: async ({
      endpoint,
      credentialId,
      token,
    }: {
      endpoint: string
      credentialId?: string | null
      token?: string | null
    }) => {
      const params = new URLSearchParams()
      params.set('endpoint', endpoint.trim() || 'http://localhost:18789')
      if (credentialId) params.set('credentialId', credentialId)
      if (token?.trim()) params.set('token', token.trim())
      return api<{ ok: boolean; models: string[]; message?: string; error?: string; hint?: string }>(
        'GET',
        `/providers/openclaw/health?${params.toString()}`,
      )
    },
  })
}

export function useDiscoverOpenClawGatewaysMutation() {
  return useMutation({
    mutationFn: () => api<{ gateways: GatewayDiscoveryResult[] }>('GET', '/openclaw/discover'),
  })
}

export function useRefreshGatewayTopologyMutation() {
  const queryClient = useQueryClient()
  return useMutation<RefreshGatewayTopologyResult, Error, string>({
    mutationFn: async (profileId) => {
      const topology = await api<OpenClawGatewayTopology>('GET', `/gateways/${profileId}/topology`)

      return {
        nodes: topology.nodes,
        nodePairings: topology.nodePairings,
        devicePairings: topology.devicePairings,
        pairedDevices: topology.pairedDevices,
        sessions: topology.sessions,
        presence: topology.presence,
        environments: topology.environments,
        errors: topology.errors,
        topology,
      }
    },
    onSuccess: async (_result, profileId) => {
      await Promise.all([
        invalidateGatewayQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: gatewayQueryKeys.topology(profileId) }),
      ])
    },
  })
}

export function useGatewayPairingDecisionMutation() {
  return useMutation({
    mutationFn: ({
      profileId,
      kind,
      requestId,
      decision,
    }: {
      profileId: string
      kind: 'node' | 'device'
      requestId: string
      decision: 'approve' | 'reject'
    }) =>
      api<GatewayRpcResponse<unknown>>('POST', '/openclaw/gateway', {
        method: kind === 'node'
          ? (decision === 'approve' ? 'node.pair.approve' : 'node.pair.reject')
          : (decision === 'approve' ? 'device.pair.approve' : 'device.pair.reject'),
        params: { profileId, requestId },
      }),
  })
}

export function useGatewayRemoveDeviceMutation() {
  return useMutation({
    mutationFn: ({ profileId, deviceId }: { profileId: string; deviceId: string }) =>
      api<GatewayRpcResponse<unknown>>('POST', '/openclaw/gateway', {
        method: 'device.pair.remove',
        params: { profileId, deviceId },
      }),
  })
}

export function useGatewayInvokeNodeMutation() {
  return useMutation({
    mutationFn: ({
      profileId,
      nodeId,
      command,
      params,
    }: {
      profileId: string
      nodeId: string
      command: string
      params: Record<string, unknown>
    }) =>
      api<GatewayRpcResponse<unknown>>('POST', '/openclaw/gateway', {
        method: 'node.invoke',
        params: {
          profileId,
          nodeId,
          command,
          params,
        },
      }),
  })
}
