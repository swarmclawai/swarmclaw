import { perf } from '@/lib/server/runtime/perf'
import {
  deletePersistedMainLoopState as deleteStoredMainLoopState,
  loadPersistedMainLoopState as loadStoredMainLoopState,
  upsertPersistedMainLoopState as upsertStoredMainLoopState,
} from '@/lib/server/storage'

export type PersistedMainLoopState = Record<string, unknown>

export function loadPersistedMainLoopState(sessionId: string): PersistedMainLoopState | null {
  return perf.measureSync(
    'repository',
    'main-loop-state.get',
    () => loadStoredMainLoopState(sessionId) as PersistedMainLoopState | null,
    { sessionId },
  )
}

export function upsertPersistedMainLoopState(
  sessionId: string,
  value: PersistedMainLoopState,
): void {
  perf.measureSync(
    'repository',
    'main-loop-state.upsert',
    () => upsertStoredMainLoopState(sessionId, value),
    { sessionId },
  )
}

export function deletePersistedMainLoopState(sessionId: string): void {
  perf.measureSync(
    'repository',
    'main-loop-state.delete',
    () => deleteStoredMainLoopState(sessionId),
    { sessionId },
  )
}
