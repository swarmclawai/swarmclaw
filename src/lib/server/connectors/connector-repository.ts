import type { Connector } from '@/types'

import {
  deleteStoredItem,
  loadConnectorHealth as loadStoredConnectorHealth,
  loadConnectors as loadStoredConnectors,
  loadStoredItem,
  saveConnectors as saveStoredConnectors,
  upsertConnectorHealthEvent as upsertStoredConnectorHealthEvent,
  upsertStoredItem,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export const connectorRepository = createRecordRepository<Connector>(
  'connectors',
  {
    get(id) {
      return loadStoredItem('connectors', id) as Connector | null
    },
    list() {
      return loadStoredConnectors() as Record<string, Connector>
    },
    upsert(id, value) {
      upsertStoredItem('connectors', id, value)
    },
    replace(data) {
      saveStoredConnectors(data)
    },
    patch(id, updater) {
      const current = loadStoredItem('connectors', id) as Connector | null
      const next = updater(current)
      if (next === null) {
        deleteStoredItem('connectors', id)
        return null
      }
      upsertStoredItem('connectors', id, next)
      return next
    },
    delete(id) {
      deleteStoredItem('connectors', id)
    },
  },
)

export const loadConnectors = () => connectorRepository.list()
export const loadConnector = (id: string) => connectorRepository.get(id)
export const saveConnectors = (items: Record<string, Connector | Record<string, unknown>>) => connectorRepository.replace(items as Record<string, Connector>)
export const upsertConnector = (id: string, value: Connector | Record<string, unknown>) => connectorRepository.upsert(id, value as Connector)
export const patchConnector = (id: string, updater: (current: Connector | null) => Connector | null) => connectorRepository.patch(id, updater)
export const deleteConnector = (id: string) => connectorRepository.delete(id)

export function loadConnectorHealth() {
  return loadStoredConnectorHealth()
}

export function upsertConnectorHealthEvent(id: string, value: Record<string, unknown>) {
  upsertStoredConnectorHealthEvent(id, value)
}
