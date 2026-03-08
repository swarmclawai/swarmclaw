import type { Schedule } from '@/types'

type ScheduleOriginShape = Pick<Schedule, 'scheduleType' | 'createdByAgentId'>

export function isAgentCreatedSchedule(schedule: ScheduleOriginShape | null | undefined): boolean {
  return Boolean(typeof schedule?.createdByAgentId === 'string' && schedule.createdByAgentId.trim())
}

export function isUserCreatedSchedule(schedule: ScheduleOriginShape | null | undefined): boolean {
  return !isAgentCreatedSchedule(schedule)
}

export function shouldAutoDeleteScheduleAfterTerminalRun(schedule: ScheduleOriginShape | null | undefined): boolean {
  return Boolean(schedule?.scheduleType === 'once' && isAgentCreatedSchedule(schedule))
}
