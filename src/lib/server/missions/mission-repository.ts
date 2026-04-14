import crypto from 'crypto'
import type {
  Mission,
  MissionEvent,
  MissionMilestone,
  MissionReport,
} from '@/types'
import { MISSION_MILESTONE_TAIL_CAP } from '@/types'
import {
  loadAgentMission,
  loadAgentMissions,
  upsertAgentMission,
  patchAgentMission,
  deleteAgentMission,
  upsertAgentMissionEvent,
  loadAgentMissionEvents,
  upsertMissionReport,
  loadMissionReports,
  loadMissionReport,
} from '@/lib/server/storage'

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`
}

export function listMissions(): Mission[] {
  const all = loadAgentMissions()
  return Object.values(all).sort((a, b) => b.createdAt - a.createdAt)
}

export function getMission(id: string): Mission | null {
  return loadAgentMission(id)
}

export function upsertMission(mission: Mission): void {
  const withTimestamps: Mission = {
    ...mission,
    updatedAt: Date.now(),
  }
  upsertAgentMission(mission.id, withTimestamps)
}

export function patchMission(
  id: string,
  updater: (current: Mission | null) => Mission | null,
): Mission | null {
  return patchAgentMission(id, (current) => {
    const next = updater(current)
    if (!next) return next
    return { ...next, updatedAt: Date.now() }
  })
}

export function removeMission(id: string): void {
  deleteAgentMission(id)
}

export function appendMissionEvent(
  missionId: string,
  kind: string,
  payload: Record<string, unknown> = {},
  opts: { sessionId?: string | null; runId?: string | null; at?: number } = {},
): MissionEvent {
  const event: MissionEvent = {
    id: newId('mev'),
    missionId,
    at: opts.at ?? Date.now(),
    kind,
    payload,
    sessionId: opts.sessionId ?? null,
    runId: opts.runId ?? null,
  }
  upsertAgentMissionEvent(event.id, event)
  return event
}

export function appendMissionMilestone(
  missionId: string,
  milestone: Omit<MissionMilestone, 'id' | 'at'> & { at?: number; id?: string },
): Mission | null {
  return patchMission(missionId, (current) => {
    if (!current) return null
    const entry: MissionMilestone = {
      id: milestone.id ?? newId('ms'),
      at: milestone.at ?? Date.now(),
      kind: milestone.kind,
      summary: milestone.summary.slice(0, 240),
      evidence: milestone.evidence,
      sessionId: milestone.sessionId ?? null,
      runId: milestone.runId ?? null,
    }
    const next = [...current.milestones, entry]
    const capped = next.length > MISSION_MILESTONE_TAIL_CAP
      ? next.slice(-MISSION_MILESTONE_TAIL_CAP)
      : next
    // Also persist to the events table so the full history is never lost
    appendMissionEvent(missionId, `milestone:${entry.kind}`, {
      milestoneId: entry.id,
      summary: entry.summary,
      evidence: entry.evidence,
    }, { sessionId: entry.sessionId, runId: entry.runId, at: entry.at })
    return { ...current, milestones: capped }
  })
}

export function listMissionEvents(missionId: string, opts: { sinceAt?: number; untilAt?: number } = {}): MissionEvent[] {
  const all = loadAgentMissionEvents()
  const sinceAt = opts.sinceAt ?? 0
  const untilAt = opts.untilAt ?? Number.MAX_SAFE_INTEGER
  return Object.values(all)
    .filter((ev) => ev.missionId === missionId && ev.at >= sinceAt && ev.at <= untilAt)
    .sort((a, b) => a.at - b.at)
}

export function saveMissionReport(report: MissionReport): void {
  upsertMissionReport(report.id, report)
  appendMissionEvent(report.missionId, 'report_generated', {
    reportId: report.id,
    format: report.format,
    fromAt: report.fromAt,
    toAt: report.toAt,
  }, { at: report.generatedAt })
}

export function getMissionReport(id: string): MissionReport | null {
  return loadMissionReport(id)
}

export function listMissionReports(missionId: string, limit = 20): MissionReport[] {
  const all = loadMissionReports()
  return Object.values(all)
    .filter((r) => r.missionId === missionId)
    .sort((a, b) => b.generatedAt - a.generatedAt)
    .slice(0, limit)
}

export { newId as newMissionId }
