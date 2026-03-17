import type { Mission, MissionEvent } from '@/types'

import {
  deleteMission as deleteStoredMission,
  loadMission as loadStoredMission,
  loadMissionEvent as loadStoredMissionEvent,
  loadMissionEvents as loadStoredMissionEvents,
  loadMissions as loadStoredMissions,
  patchMission as patchStoredMission,
  saveMissionEvents as saveStoredMissionEvents,
  saveMissions as saveStoredMissions,
  upsertMission as upsertStoredMission,
  upsertMissionEvent as upsertStoredMissionEvent,
  upsertMissionEvents as upsertStoredMissionEvents,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export const missionRepository = createRecordRepository<Mission>(
  'missions',
  {
    get(id) {
      return loadStoredMission(id) as Mission | null
    },
    list() {
      return loadStoredMissions() as Record<string, Mission>
    },
    upsert(id, value) {
      upsertStoredMission(id, value as Mission)
    },
    replace(data) {
      saveStoredMissions(data as Record<string, Mission>)
    },
    patch(id, updater) {
      return patchStoredMission(id, updater as (current: Mission | null) => Mission | null) as Mission | null
    },
    delete(id) {
      deleteStoredMission(id)
    },
  },
)

export const missionEventRepository = createRecordRepository<MissionEvent>(
  'mission-events',
  {
    get(id) {
      return loadStoredMissionEvent(id) as MissionEvent | null
    },
    list() {
      return loadStoredMissionEvents() as Record<string, MissionEvent>
    },
    upsert(id, value) {
      upsertStoredMissionEvent(id, value as MissionEvent)
    },
    upsertMany(entries) {
      upsertStoredMissionEvents(entries as Array<[string, MissionEvent]>)
    },
    replace(data) {
      saveStoredMissionEvents(data as Record<string, MissionEvent>)
    },
  },
)

export const loadMissions = () => missionRepository.list()
export const loadMission = (id: string) => missionRepository.get(id)
export const saveMissions = (items: Record<string, Mission | Record<string, unknown>>) => missionRepository.replace(items as Record<string, Mission>)
export const upsertMission = (id: string, value: Mission | Record<string, unknown>) => missionRepository.upsert(id, value as Mission)
export const patchMission = (id: string, updater: (current: Mission | null) => Mission | null) => missionRepository.patch(id, updater)
export const deleteMission = (id: string) => missionRepository.delete(id)

export const loadMissionEvents = () => missionEventRepository.list()
export const loadMissionEvent = (id: string) => missionEventRepository.get(id)
export const saveMissionEvents = (items: Record<string, MissionEvent | Record<string, unknown>>) => missionEventRepository.replace(items as Record<string, MissionEvent>)
export const upsertMissionEvent = (id: string, value: MissionEvent | Record<string, unknown>) => missionEventRepository.upsert(id, value as MissionEvent)
export const upsertMissionEvents = (entries: Array<[string, MissionEvent | Record<string, unknown>]>) => missionEventRepository.upsertMany(entries as Array<[string, MissionEvent]>)
