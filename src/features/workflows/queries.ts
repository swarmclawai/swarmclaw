import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/app/api-client'
import { protocolQueryKeys } from '@/features/protocols/queries'
import { taskQueryKeys } from '@/features/tasks/queries'
import type {
  WorkflowBundleLaunchResult,
  WorkflowBundleSpec,
  WorkflowContinuationResult,
  WorkflowLedger,
  WorkflowPlanDraft,
} from '@/types'

export const workflowQueryKeys = {
  all: ['workflows'] as const,
  ledger: (runId: string | null) => ['workflows', 'ledger', runId] as const,
}

export interface WorkflowPlanRequest {
  title?: string
  goal: string
  cwd?: string | null
  projectId?: string | null
  allowedScopes?: string[]
  safetyProfile?: Record<string, unknown>
}

export function useWorkflowLedgerQuery(runId: string | null, options: { enabled?: boolean } = {}) {
  return useQuery<WorkflowLedger | null>({
    queryKey: workflowQueryKeys.ledger(runId),
    queryFn: () => api<WorkflowLedger>('GET', `/workflows/runs/${runId}/ledger`),
    enabled: options.enabled ?? Boolean(runId),
    staleTime: 5_000,
  })
}

export function useCreateWorkflowPlanMutation() {
  return useMutation({
    mutationFn: (payload: WorkflowPlanRequest) => api<WorkflowPlanDraft>('POST', '/workflows/plans', payload),
  })
}

export function useCreateWorkflowBundleMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: WorkflowBundleSpec) => api<WorkflowBundleLaunchResult>('POST', '/workflows/bundles', payload),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workflowQueryKeys.all }),
        queryClient.invalidateQueries({ queryKey: protocolQueryKeys.all }),
        queryClient.invalidateQueries({ queryKey: taskQueryKeys.all }),
      ])
    },
  })
}

export function useContinueWorkflowRunMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ runId, payload }: { runId: string; payload?: Record<string, unknown> }) =>
      api<WorkflowContinuationResult>('POST', `/workflows/runs/${runId}/continue`, payload || {}),
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workflowQueryKeys.ledger(variables.runId) }),
        queryClient.invalidateQueries({ queryKey: protocolQueryKeys.all }),
        queryClient.invalidateQueries({ queryKey: taskQueryKeys.all }),
      ])
    },
  })
}
