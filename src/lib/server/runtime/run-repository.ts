import type { RunEventRecord, SessionRunRecord } from '@/types'

import {
  deleteStoredItem,
  loadRuntimeRun as loadStoredRuntimeRun,
  loadRuntimeRunEvents as loadStoredRuntimeRunEvents,
  loadRuntimeRunEventsByRunId as loadStoredRuntimeRunEventsByRunId,
  loadRuntimeRuns as loadStoredRuntimeRuns,
  patchRuntimeRun as patchStoredRuntimeRun,
  saveRuntimeRunEvents as saveStoredRuntimeRunEvents,
  saveRuntimeRuns as saveStoredRuntimeRuns,
  upsertRuntimeRun as upsertStoredRuntimeRun,
  upsertRuntimeRunEvent as upsertStoredRuntimeRunEvent,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export const runRepository = createRecordRepository<SessionRunRecord>(
  'runtime-runs',
  {
    get(id) {
      return loadStoredRuntimeRun(id) as SessionRunRecord | null
    },
    list() {
      return loadStoredRuntimeRuns() as Record<string, SessionRunRecord>
    },
    upsert(id, value) {
      upsertStoredRuntimeRun(id, value as SessionRunRecord)
    },
    replace(data) {
      saveStoredRuntimeRuns(data as Record<string, SessionRunRecord>)
    },
    patch(id, updater) {
      return patchStoredRuntimeRun(id, updater as (current: SessionRunRecord | null) => SessionRunRecord | null) as SessionRunRecord | null
    },
    delete(id) {
      deleteStoredItem('runtime_runs', id)
    },
  },
)

export const runEventRepository = createRecordRepository<RunEventRecord>(
  'runtime-run-events',
  {
    get(id) {
      return (loadStoredRuntimeRunEvents() as Record<string, RunEventRecord>)[id] || null
    },
    list() {
      return loadStoredRuntimeRunEvents() as Record<string, RunEventRecord>
    },
    upsert(id, value) {
      upsertStoredRuntimeRunEvent(id, value as RunEventRecord)
    },
    replace(data) {
      saveStoredRuntimeRunEvents(data as Record<string, RunEventRecord>)
    },
    delete(id) {
      deleteStoredItem('runtime_run_events', id)
    },
  },
)

export const loadRuntimeRuns = () => runRepository.list()
export const saveRuntimeRuns = (items: Record<string, SessionRunRecord | Record<string, unknown>>) => runRepository.replace(items as Record<string, SessionRunRecord>)
export const loadRuntimeRun = (id: string) => runRepository.get(id)
export const upsertRuntimeRun = (id: string, value: SessionRunRecord | Record<string, unknown>) => runRepository.upsert(id, value as SessionRunRecord)
export const patchRuntimeRun = (id: string, updater: (current: SessionRunRecord | null) => SessionRunRecord | null) => runRepository.patch(id, updater)

export const loadRuntimeRunEvents = () => runEventRepository.list()
export const saveRuntimeRunEvents = (items: Record<string, RunEventRecord | Record<string, unknown>>) => runEventRepository.replace(items as Record<string, RunEventRecord>)
export const upsertRuntimeRunEvent = (id: string, value: RunEventRecord | Record<string, unknown>) => runEventRepository.upsert(id, value as RunEventRecord)
export const loadRuntimeRunEventsByRunId = (runId: string) => loadStoredRuntimeRunEventsByRunId(runId)
export const deleteRuntimeRun = (id: string) => runRepository.delete(id)
export const deleteRuntimeRunEvent = (id: string) => runEventRepository.delete(id)
