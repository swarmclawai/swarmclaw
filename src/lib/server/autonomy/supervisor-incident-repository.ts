import type { SupervisorIncident } from '@/types'

import {
  loadSupervisorIncident as loadStoredSupervisorIncident,
  loadSupervisorIncidents as loadStoredSupervisorIncidents,
  saveSupervisorIncidents as saveStoredSupervisorIncidents,
  upsertSupervisorIncident as upsertStoredSupervisorIncident,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export const supervisorIncidentRepository = createRecordRepository<SupervisorIncident>(
  'supervisor-incidents',
  {
    get(id) {
      return loadStoredSupervisorIncident(id) as SupervisorIncident | null
    },
    list() {
      return loadStoredSupervisorIncidents() as Record<string, SupervisorIncident>
    },
    upsert(id, value) {
      upsertStoredSupervisorIncident(id, value as SupervisorIncident)
    },
    replace(data) {
      saveStoredSupervisorIncidents(data as Record<string, SupervisorIncident>)
    },
  },
)

export const loadSupervisorIncidents = () => supervisorIncidentRepository.list()
export const loadSupervisorIncident = (id: string) => supervisorIncidentRepository.get(id)
export const saveSupervisorIncidents = (items: Record<string, SupervisorIncident | Record<string, unknown>>) => (
  supervisorIncidentRepository.replace(items as Record<string, SupervisorIncident>)
)
export const upsertSupervisorIncident = (id: string, value: SupervisorIncident | Record<string, unknown>) => (
  supervisorIncidentRepository.upsert(id, value as SupervisorIncident)
)

export function listAgentIncidents(agentId?: string): SupervisorIncident[] {
  return Object.values(loadSupervisorIncidents())
    .filter((incident) => !agentId || incident.agentId === agentId)
    .sort((left, right) => right.createdAt - left.createdAt)
}
