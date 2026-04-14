import { log } from '@/lib/server/logger'
import { hmrSingleton } from '@/lib/shared-utils'
import { createNotification } from '@/lib/server/create-notification'
import type { Mission } from '@/types'
import {
  listMissions,
  patchMission,
  saveMissionReport,
} from './mission-repository'
import { buildMissionReport } from './mission-report-builder'
import { markBudgetExhausted } from './mission-service'

const TAG = 'mission-scheduler'

interface SchedulerState {
  lastTickAt: number
  inFlight: boolean
}

const state = hmrSingleton<SchedulerState>('mission_scheduler_state', () => ({
  lastTickAt: 0,
  inFlight: false,
}))

function dispatchInAppReport(mission: Mission, title: string, message: string): void {
  try {
    createNotification({
      type: 'info',
      title,
      message,
      entityType: 'mission',
      entityId: mission.id,
      actionLabel: 'Open mission',
      actionUrl: `/missions/${mission.id}`,
      dedupKey: `mission-report:${mission.id}:${Date.now()}`,
    })
  } catch (error) {
    log.warn(TAG, `Failed to emit notification for mission ${mission.id}`, error)
  }
}

function generateReportForMission(mission: Mission, isFinal: boolean, reason?: string): void {
  try {
    const from = mission.reportSchedule?.lastReportAt
      ?? mission.usage.startedAt
      ?? mission.createdAt
    const to = Date.now()
    const { report, deliveryMessage, deliveryTitle } = buildMissionReport(mission, { from, to }, {
      isFinal,
      windowSource: isFinal ? 'final' : 'schedule',
    })
    saveMissionReport(report)
    dispatchInAppReport(mission, deliveryTitle, reason ?? deliveryMessage)
    if (!isFinal && mission.reportSchedule) {
      patchMission(mission.id, (current) => {
        if (!current || !current.reportSchedule) return current
        return {
          ...current,
          reportSchedule: { ...current.reportSchedule, lastReportAt: to },
        }
      })
    }
  } catch (error) {
    log.error(TAG, `Failed to generate report for mission ${mission.id}`, error)
  }
}

export function runMissionScheduler(): void {
  if (state.inFlight) return
  state.inFlight = true
  try {
    const now = Date.now()
    state.lastTickAt = now
    const missions = listMissions()
    for (const mission of missions) {
      if (mission.status !== 'running') continue

      // Wallclock budget enforcement (scheduler is the authority for time-based exhaustion)
      const startedAt = mission.usage.startedAt
      if (mission.budget.maxWallclockSec != null && startedAt != null) {
        const elapsedSec = (now - startedAt) / 1000
        if (elapsedSec >= mission.budget.maxWallclockSec) {
          const reason = `Wallclock budget exceeded (${Math.round(elapsedSec)}s)`
          markBudgetExhausted(mission.id, reason)
          // Reload the mission to pick up the new status before generating the final report.
          const updated = listMissions().find((m) => m.id === mission.id)
          if (updated) generateReportForMission(updated, true, reason)
          continue
        }
      }

      // Report schedule
      const schedule = mission.reportSchedule
      if (!schedule || !schedule.enabled) continue
      const lastAt = schedule.lastReportAt ?? startedAt ?? mission.createdAt
      const intervalMs = Math.max(30, schedule.intervalSec) * 1000
      if (now - lastAt < intervalMs) continue
      generateReportForMission(mission, false)
    }
  } finally {
    state.inFlight = false
  }
}

export function getSchedulerLastTickAt(): number {
  return state.lastTickAt
}
