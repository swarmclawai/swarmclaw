import { genId } from '@/lib/id'
import type { DelegationJobArtifact, DelegationJobCheckpoint, DelegationJobRecord, DelegationJobStatus } from '@/types'
import { loadDelegationJobs, upsertDelegationJob, patchDelegationJob } from './storage'
import { notify } from './ws-hub'

interface DelegationRuntimeHandle {
  cancel?: () => void
}

const runtimeKey = '__swarmclaw_delegation_job_runtime__' as const
const runtimeScope = globalThis as typeof globalThis & {
  [runtimeKey]?: Map<string, DelegationRuntimeHandle>
}
const runtimeHandles = runtimeScope[runtimeKey] ?? (runtimeScope[runtimeKey] = new Map())

function isTerminalStatus(status: DelegationJobStatus | null | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function appendCheckpoint(
  existing: DelegationJobCheckpoint[] | undefined,
  checkpoint: DelegationJobCheckpoint,
): DelegationJobCheckpoint[] {
  return [...(existing || []), checkpoint].slice(-24)
}

function notifyDelegationJobsChanged() {
  notify('delegation_jobs')
}

export interface CreateDelegationJobInput {
  kind: DelegationJobRecord['kind']
  task: string
  backend?: DelegationJobRecord['backend']
  parentSessionId?: string | null
  childSessionId?: string | null
  agentId?: string | null
  agentName?: string | null
  cwd?: string | null
}

export function createDelegationJob(input: CreateDelegationJobInput): DelegationJobRecord {
  const createdAt = Date.now()
  const job: DelegationJobRecord = {
    id: genId(10),
    kind: input.kind,
    status: 'queued',
    backend: input.backend ?? null,
    parentSessionId: input.parentSessionId ?? null,
    childSessionId: input.childSessionId ?? null,
    agentId: input.agentId ?? null,
    agentName: input.agentName ?? null,
    cwd: input.cwd ?? null,
    task: input.task,
    result: null,
    resultPreview: null,
    error: null,
    checkpoints: [{
      at: createdAt,
      note: 'Job queued',
      status: 'queued',
    }],
    artifacts: [],
    resumeId: null,
    resumeIds: {},
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null,
  }
  upsertDelegationJob(job.id, job)
  notifyDelegationJobsChanged()
  return job
}

export function getDelegationJob(id: string): DelegationJobRecord | null {
  const all = loadDelegationJobs()
  const current = all[id]
  if (!current || typeof current !== 'object') return null
  return current as DelegationJobRecord
}

export function listDelegationJobs(filter?: {
  parentSessionId?: string | null
  status?: DelegationJobStatus | null
}): DelegationJobRecord[] {
  return Object.values(loadDelegationJobs())
    .filter((job): job is DelegationJobRecord => !!job && typeof job === 'object')
    .filter((job) => !filter?.parentSessionId || job.parentSessionId === filter.parentSessionId)
    .filter((job) => !filter?.status || job.status === filter.status)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

export function updateDelegationJob(
  id: string,
  patch: Partial<DelegationJobRecord>,
): DelegationJobRecord | null {
  const result = patchDelegationJob(id, (current) => {
    if (!current) return null
    return {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    }
  })
  if (result) notifyDelegationJobsChanged()
  return result as any
}

export function appendDelegationCheckpoint(
  id: string,
  note: string,
  status?: DelegationJobStatus,
): DelegationJobRecord | null {
  const current = getDelegationJob(id)
  if (!current) return null
  if (isTerminalStatus(current.status) && status && status !== current.status) {
    return current
  }
  return updateDelegationJob(id, {
    status: isTerminalStatus(current.status) ? current.status : (status ?? current.status),
    checkpoints: appendCheckpoint(current.checkpoints, { at: Date.now(), note, status }),
  })
}

export function startDelegationJob(id: string, patch?: Partial<DelegationJobRecord>): DelegationJobRecord | null {
  const current = getDelegationJob(id)
  if (!current) return null
  if (isTerminalStatus(current.status)) return current
  return updateDelegationJob(id, {
    ...patch,
    status: 'running',
    startedAt: Date.now(),
  })
}

export function completeDelegationJob(
  id: string,
  result: string,
  patch?: Partial<DelegationJobRecord>,
): DelegationJobRecord | null {
  runtimeHandles.delete(id)
  const current = getDelegationJob(id)
  if (!current) return null
  if (isTerminalStatus(current.status)) return current
  return updateDelegationJob(id, {
    ...patch,
    status: 'completed',
    result,
    resultPreview: result.slice(0, 1000),
    error: null,
    completedAt: Date.now(),
  })
}

export function failDelegationJob(id: string, error: string, patch?: Partial<DelegationJobRecord>): DelegationJobRecord | null {
  runtimeHandles.delete(id)
  const current = getDelegationJob(id)
  if (!current) return null
  if (isTerminalStatus(current.status)) return current
  return updateDelegationJob(id, {
    ...patch,
    status: 'failed',
    error,
    completedAt: Date.now(),
  })
}

export function cancelDelegationJob(id: string): DelegationJobRecord | null {
  const current = getDelegationJob(id)
  if (!current) return null
  if (isTerminalStatus(current.status)) return current
  const runtime = runtimeHandles.get(id)
  try {
    runtime?.cancel?.()
  } catch {
    // best-effort cancel
  }
  // Commit state before deleting handle — if the update fails, the handle
  // stays intact for a future retry rather than being orphaned.
  const result = updateDelegationJob(id, {
    status: 'cancelled',
    completedAt: Date.now(),
    error: null,
    checkpoints: appendCheckpoint(current.checkpoints, {
      at: Date.now(),
      note: 'Job cancelled',
      status: 'cancelled',
    }),
  })
  runtimeHandles.delete(id)
  return result as any
}

export function cancelDelegationJobsForParentSession(
  parentSessionId: string,
  note = 'Parent session cancelled',
): number {
  if (!parentSessionId) return 0
  const jobs = listDelegationJobs({ parentSessionId })
    .filter((job) => job.status === 'queued' || job.status === 'running')
  let cancelled = 0
  for (const job of jobs) {
    const next = cancelDelegationJob(job.id)
    if (!next || next.status !== 'cancelled') continue
    cancelled += 1
    const checkpoints = Array.isArray(next.checkpoints) ? next.checkpoints : []
    const last = checkpoints[checkpoints.length - 1]
    if (!last || last.note !== note) {
      updateDelegationJob(job.id, {
        checkpoints: appendCheckpoint(next.checkpoints, {
          at: Date.now(),
          note,
          status: 'cancelled',
        }),
      })
    }
  }
  return cancelled
}

export function registerDelegationRuntime(id: string, handle: DelegationRuntimeHandle) {
  runtimeHandles.set(id, handle)
}

export function appendDelegationArtifacts(id: string, artifacts: DelegationJobArtifact[]): DelegationJobRecord | null {
  const current = getDelegationJob(id)
  if (!current) return null
  return updateDelegationJob(id, {
    artifacts: [...(current.artifacts || []), ...artifacts].slice(-24),
  })
}

export function recoverStaleDelegationJobs(maxAgeMs = 15 * 60_000): number {
  const threshold = Date.now() - maxAgeMs
  const stale = listDelegationJobs().filter((job) =>
    (job.status === 'queued' || job.status === 'running')
    && !runtimeHandles.has(job.id)
    && (job.updatedAt || job.createdAt) < threshold,
  )
  for (const job of stale) {
    failDelegationJob(job.id, 'Delegation job was interrupted before completion.')
  }
  return stale.length
}
