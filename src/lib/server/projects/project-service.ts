import type { Agent, BoardTask, Project, Schedule, Skill, StoredSecret } from '@/types'

import {
  deleteProject as deleteStoredProject,
  loadAgents,
  loadProjects,
  loadSchedules,
  loadSecrets,
  loadSkills,
  loadTasks,
  saveAgents,
  saveProjects,
  saveSchedules,
  saveSecrets,
  saveSkills,
  saveTasks,
} from '@/lib/server/storage'
import { ensureProjectWorkspace, normalizeProjectPatchInput } from '@/lib/server/project-utils'
import { notify } from '@/lib/server/ws-hub'

type ProjectLinkedRecord = {
  projectId?: string
}

function clearProjectId<T extends ProjectLinkedRecord>(
  projectId: string,
  load: () => Record<string, T>,
  save: (items: Record<string, T>) => void,
  topic: string,
): void {
  const items = load()
  let changed = false
  for (const item of Object.values(items)) {
    if (item.projectId !== projectId) continue
    item.projectId = undefined
    changed = true
  }
  if (!changed) return
  save(items)
  notify(topic)
}

export function getProject(id: string): Project | null {
  return loadProjects()[id] || null
}

export function updateProject(id: string, input: Record<string, unknown>): Project | null {
  const projects = loadProjects()
  const existing = projects[id]
  if (!existing) return null

  const patch = normalizeProjectPatchInput(input)
  const nextProject: Project = {
    ...existing,
    ...patch,
    id,
    updatedAt: Date.now(),
  }
  projects[id] = nextProject
  saveProjects(projects)
  ensureProjectWorkspace(id, nextProject.name)
  notify('projects')
  return nextProject
}

export function deleteProjectAndDetachReferences(id: string): boolean {
  if (!getProject(id)) return false

  deleteStoredProject(id)
  notify('projects')

  clearProjectId<Agent>(id, loadAgents, saveAgents, 'agents')
  clearProjectId<BoardTask>(id, loadTasks, saveTasks, 'tasks')
  clearProjectId<Schedule>(id, loadSchedules, saveSchedules, 'schedules')
  clearProjectId<Skill>(id, loadSkills, saveSkills, 'skills')
  clearProjectId<StoredSecret>(id, loadSecrets, saveSecrets, 'secrets')

  return true
}
