import type { BoardTask } from '@/types'

import {
  deleteTask as deleteStoredTask,
  loadTask as loadStoredTask,
  loadTasks as loadStoredTasks,
  patchTask as patchStoredTask,
  saveTasks as saveStoredTasks,
  upsertTask as upsertStoredTask,
  upsertTasks as upsertStoredTasks,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export const taskRepository = createRecordRepository<BoardTask>(
  'tasks',
  {
    get(id) {
      return loadStoredTask(id) as BoardTask | null
    },
    list() {
      return loadStoredTasks() as Record<string, BoardTask>
    },
    upsert(id, value) {
      upsertStoredTask(id, value as BoardTask)
    },
    upsertMany(entries) {
      upsertStoredTasks(entries as Array<[string, BoardTask]>)
    },
    replace(data) {
      saveStoredTasks(data as Record<string, BoardTask>)
    },
    patch(id, updater) {
      return patchStoredTask(id, updater as (current: BoardTask | null) => BoardTask | null) as BoardTask | null
    },
    delete(id) {
      deleteStoredTask(id)
    },
  },
)

export const getTask = (id: string) => taskRepository.get(id)
export const getTasks = (ids: string[]) => taskRepository.getMany(ids)
export const listTasks = () => taskRepository.list()
export const saveTask = (id: string, task: BoardTask | Record<string, unknown>) => taskRepository.upsert(id, task as BoardTask)
export const saveTaskMany = (entries: Array<[string, BoardTask | Record<string, unknown>]>) => taskRepository.upsertMany(entries as Array<[string, BoardTask]>)
export const replaceTasks = (items: Record<string, BoardTask | Record<string, unknown>>) => taskRepository.replace(items as Record<string, BoardTask>)
export const patchTask = (id: string, updater: (current: BoardTask | null) => BoardTask | null) => taskRepository.patch(id, updater)
export const deleteTask = (id: string) => taskRepository.delete(id)

export const loadTasks = listTasks
export const loadTask = getTask
export const saveTasks = replaceTasks
export const upsertTask = saveTask
export const upsertTasks = saveTaskMany
