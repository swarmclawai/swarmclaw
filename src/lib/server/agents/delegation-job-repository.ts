import type { DelegationJobRecord } from '@/types'

import {
  deleteDelegationJob as deleteStoredDelegationJob,
  loadDelegationJobItem as loadStoredDelegationJob,
  loadDelegationJobs as loadStoredDelegationJobs,
  patchDelegationJob as patchStoredDelegationJob,
  upsertDelegationJob as upsertStoredDelegationJob,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export const delegationJobRepository = createRecordRepository<DelegationJobRecord>(
  'delegation-jobs',
  {
    get(id) {
      return loadStoredDelegationJob(id) as DelegationJobRecord | null
    },
    list() {
      return loadStoredDelegationJobs() as Record<string, DelegationJobRecord>
    },
    upsert(id, value) {
      upsertStoredDelegationJob(id, value as DelegationJobRecord)
    },
    patch(id, updater) {
      return patchStoredDelegationJob(
        id,
        updater as (current: DelegationJobRecord | null) => DelegationJobRecord | null,
      ) as DelegationJobRecord | null
    },
    delete(id) {
      deleteStoredDelegationJob(id)
    },
  },
)

export const getDelegationJobRecord = (id: string) => delegationJobRepository.get(id)
export const getDelegationJobRecords = (ids: string[]) => delegationJobRepository.getMany(ids)
export const listDelegationJobRecords = () => delegationJobRepository.list()
export const saveDelegationJobRecord = (id: string, value: DelegationJobRecord | Record<string, unknown>) =>
  delegationJobRepository.upsert(id, value as DelegationJobRecord)
export const saveDelegationJobRecords = (entries: Array<[string, DelegationJobRecord | Record<string, unknown>]>) =>
  delegationJobRepository.upsertMany(entries as Array<[string, DelegationJobRecord]>)
export const patchDelegationJobRecord = (
  id: string,
  updater: (current: DelegationJobRecord | null) => DelegationJobRecord | null,
) => delegationJobRepository.patch(id, updater)
export const deleteDelegationJobRecord = (id: string) => delegationJobRepository.delete(id)

export const loadDelegationJobs = listDelegationJobRecords
export const loadDelegationJob = getDelegationJobRecord
export const upsertDelegationJob = saveDelegationJobRecord
export const patchDelegationJob = patchDelegationJobRecord
export const deleteDelegationJob = deleteDelegationJobRecord
