import type { WatchJob } from '@/types'

import {
  deleteWatchJob as deleteStoredWatchJob,
  loadWatchJobs as loadStoredWatchJobs,
  upsertWatchJob as upsertStoredWatchJob,
  upsertWatchJobs as upsertStoredWatchJobs,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export const watchJobRepository = createRecordRepository<WatchJob>(
  'watch-jobs',
  {
    get(id) {
      return (loadStoredWatchJobs() as Record<string, WatchJob>)[id] || null
    },
    list() {
      return loadStoredWatchJobs() as Record<string, WatchJob>
    },
    upsert(id, value) {
      upsertStoredWatchJob(id, value as WatchJob)
    },
    upsertMany(entries) {
      upsertStoredWatchJobs(entries as Array<[string, WatchJob]>)
    },
    delete(id) {
      deleteStoredWatchJob(id)
    },
  },
)

export const loadWatchJobs = () => watchJobRepository.list()
export const upsertWatchJob = (id: string, value: WatchJob | Record<string, unknown>) => watchJobRepository.upsert(id, value as WatchJob)
export const upsertWatchJobs = (entries: Array<[string, WatchJob | Record<string, unknown>]>) => watchJobRepository.upsertMany(entries as Array<[string, WatchJob]>)
export const deleteWatchJob = (id: string) => watchJobRepository.delete(id)
