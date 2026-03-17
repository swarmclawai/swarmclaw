import type { Project } from '@/types'

import {
  deleteProject as deleteStoredProject,
  loadProjects as loadStoredProjects,
  saveProjects as saveStoredProjects,
  upsertStoredItem,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export const projectRepository = createRecordRepository<Project>(
  'projects',
  {
    get(id) {
      return (loadStoredProjects() as Record<string, Project>)[id] || null
    },
    list() {
      return loadStoredProjects() as Record<string, Project>
    },
    upsert(id, value) {
      upsertStoredItem('projects', id, value)
    },
    replace(data) {
      saveStoredProjects(data)
    },
    delete(id) {
      deleteStoredProject(id)
    },
  },
)

export const loadProjects = () => projectRepository.list()
export const loadProject = (id: string) => projectRepository.get(id)
export const saveProjects = (items: Record<string, Project | Record<string, unknown>>) => projectRepository.replace(items as Record<string, Project>)
export const upsertProject = (id: string, value: Project | Record<string, unknown>) => projectRepository.upsert(id, value as Project)
export const deleteProject = (id: string) => projectRepository.delete(id)
