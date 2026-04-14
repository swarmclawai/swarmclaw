import { log } from '@/lib/server/logger'
import { evaluateMissionBudget, markBudgetExhausted } from './mission-service'
import { getMission } from './mission-repository'

const TAG = 'mission-budget'

export interface MissionBudgetHookResult {
  allow: boolean
  reason?: string
}

/**
 * Pure, synchronous check suitable for the hot enqueue path. When the hook
 * denies a run it also fires a side-effect to transition the mission to
 * budget_exhausted — callers should throw on `allow: false` to surface the
 * block to the caller (heartbeat loops back off on thrown errors).
 */
export function checkMissionBudgetForSession(missionId: string | null | undefined): MissionBudgetHookResult {
  if (!missionId) return { allow: true }
  const mission = getMission(missionId)
  if (!mission) return { allow: true }
  if (mission.status !== 'running') {
    if (mission.status === 'paused' || mission.status === 'draft') {
      return { allow: false, reason: `Mission ${mission.id} is ${mission.status}` }
    }
    return { allow: false, reason: `Mission ${mission.id} is ${mission.status}` }
  }
  const verdict = evaluateMissionBudget(mission)
  if (!verdict.allow) {
    try {
      markBudgetExhausted(mission.id, verdict.reason ?? 'Budget exhausted')
    } catch (error) {
      log.warn(TAG, `Failed to transition mission ${mission.id} to budget_exhausted`, error)
    }
    return { allow: false, reason: verdict.reason }
  }
  return { allow: true }
}
