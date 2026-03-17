import type { Schedule } from '@/types'

import {
  deleteSchedule as deleteStoredSchedule,
  loadSchedule as loadStoredSchedule,
  loadSchedules as loadStoredSchedules,
  saveSchedules as saveStoredSchedules,
  upsertSchedule as upsertStoredSchedule,
  upsertSchedules as upsertStoredSchedules,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export const scheduleRepository = createRecordRepository<Schedule>(
  'schedules',
  {
    get(id) {
      return loadStoredSchedule(id) as Schedule | null
    },
    list() {
      return loadStoredSchedules() as Record<string, Schedule>
    },
    upsert(id, value) {
      upsertStoredSchedule(id, value as Schedule)
    },
    upsertMany(entries) {
      upsertStoredSchedules(entries as Array<[string, Schedule]>)
    },
    replace(data) {
      saveStoredSchedules(data as Record<string, Schedule>)
    },
    delete(id) {
      deleteStoredSchedule(id)
    },
  },
)

export const loadSchedules = () => scheduleRepository.list()
export const loadSchedule = (id: string) => scheduleRepository.get(id)
export const saveSchedules = (items: Record<string, Schedule | Record<string, unknown>>) => scheduleRepository.replace(items as Record<string, Schedule>)
export const upsertSchedule = (id: string, value: Schedule | Record<string, unknown>) => scheduleRepository.upsert(id, value as Schedule)
export const upsertSchedules = (entries: Array<[string, Schedule | Record<string, unknown>]>) => scheduleRepository.upsertMany(entries as Array<[string, Schedule]>)
export const deleteSchedule = (id: string) => scheduleRepository.delete(id)
