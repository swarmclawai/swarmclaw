import { api } from './api-client'
import type { Schedule } from '../types'

export const fetchSchedules = () => api<Record<string, Schedule>>('GET', '/schedules')

export const createSchedule = (data: Omit<Schedule, 'id' | 'createdAt' | 'lastRunAt' | 'nextRunAt'>) =>
  api<Schedule>('POST', '/schedules', data)

export const updateSchedule = (id: string, data: Partial<Schedule>) =>
  api<Schedule>('PUT', `/schedules/${id}`, data)

export const deleteSchedule = (id: string) =>
  api<string>('DELETE', `/schedules/${id}`)

export const runSchedule = (id: string) =>
  api<{ ok: boolean }>('POST', `/schedules/${id}/run`)
