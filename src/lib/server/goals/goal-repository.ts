import type { Goal } from '@/types'
import { loadGoals, loadGoal, upsertGoal, deleteGoalItem } from '@/lib/server/storage'
import { perf } from '@/lib/server/runtime/perf'

export function listGoals(): Record<string, Goal> {
  return perf.measureSync('repository', 'goals.list', () => loadGoals()) as Record<string, Goal>
}

export function getGoal(id: string): Goal | null {
  return perf.measureSync('repository', 'goals.get', () => loadGoal(id)) as Goal | null
}

export function saveGoal(id: string, goal: Goal): void {
  perf.measureSync('repository', 'goals.upsert', () => upsertGoal(id, goal), { id })
}

export function removeGoal(id: string): void {
  perf.measureSync('repository', 'goals.delete', () => deleteGoalItem(id), { id })
}
