import { api } from '@/lib/app/api-client'
import type { Schedule } from '@/types'

export interface ScheduleArchiveResponse {
  ok: boolean
  archivedIds: string[]
  cancelledTaskIds: string[]
  removedQueuedTaskIds?: string[]
  abortedRunSessionIds?: string[]
  schedule?: Schedule | null
}

export interface ScheduleRestoreResponse extends Schedule {
  restoredIds: string[]
}

export interface SchedulePurgeResponse {
  ok: boolean
  purgedIds: string[]
}

export const fetchSchedules = (includeArchived = false) =>
  api<Record<string, Schedule>>('GET', `/schedules${includeArchived ? '?includeArchived=true' : ''}`)

export const createSchedule = (data: Omit<Schedule, 'id' | 'createdAt' | 'lastRunAt' | 'nextRunAt'>) =>
  api<Schedule>('POST', '/schedules', data)

export const updateSchedule = (id: string, data: Partial<Schedule>) =>
  api<Schedule>('PUT', `/schedules/${id}`, data)

export const deleteSchedule = (id: string) =>
  api<ScheduleArchiveResponse>('DELETE', `/schedules/${id}`)

export const archiveSchedule = (id: string) =>
  api<ScheduleArchiveResponse>('DELETE', `/schedules/${id}`)

export const restoreSchedule = (id: string) =>
  api<ScheduleRestoreResponse>('PUT', `/schedules/${id}`, { restore: true })

export const purgeSchedule = (id: string) =>
  api<SchedulePurgeResponse>('DELETE', `/schedules/${id}?purge=true`)

export const runSchedule = (id: string) =>
  api<{ ok: boolean; queued?: boolean; reason?: string; taskId?: string; runNumber?: number }>('POST', `/schedules/${id}/run`)
