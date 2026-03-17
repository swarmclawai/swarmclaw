import type { GuardianCheckpoint } from '@/types'

import {
  loadGuardianCheckpoints as loadStoredGuardianCheckpoints,
  patchGuardianCheckpoint as patchStoredGuardianCheckpoint,
  upsertGuardianCheckpoint as upsertStoredGuardianCheckpoint,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export const guardianCheckpointRepository = createRecordRepository<GuardianCheckpoint>(
  'guardian-checkpoints',
  {
    get(id) {
      return loadStoredGuardianCheckpoints()[id] || null
    },
    list() {
      return loadStoredGuardianCheckpoints()
    },
    upsert(id, value) {
      upsertStoredGuardianCheckpoint(id, value as GuardianCheckpoint)
    },
    patch(id, updater) {
      return patchStoredGuardianCheckpoint(id, updater)
    },
  },
)

export const loadGuardianCheckpoints = () => guardianCheckpointRepository.list()
export const loadGuardianCheckpoint = (id: string) => guardianCheckpointRepository.get(id)
export const upsertGuardianCheckpoint = (id: string, value: GuardianCheckpoint | Record<string, unknown>) =>
  guardianCheckpointRepository.upsert(id, value as GuardianCheckpoint)
export const patchGuardianCheckpoint = (
  id: string,
  updater: (current: GuardianCheckpoint | null) => GuardianCheckpoint | null,
) => guardianCheckpointRepository.patch(id, updater)
