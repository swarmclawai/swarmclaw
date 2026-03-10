import { StateCreator } from 'zustand'
import type { AppState } from '../use-app-store'
import type { BoardTask } from '../../types'
import { fetchTasks } from '../../lib/tasks'
import { api } from '@/lib/app/api-client'
import { setIfChanged, invalidateFingerprint } from '../set-if-changed'

export interface TaskSlice {
  tasks: Record<string, BoardTask>
  loadTasks: (includeArchived?: boolean) => Promise<void>
  optimisticUpdateTask: (taskId: string, patch: Partial<BoardTask>) => Promise<boolean>
  optimisticDeleteTask: (taskId: string) => Promise<boolean>
  showArchivedTasks: boolean
  setShowArchivedTasks: (show: boolean) => void
}

export const createTaskSlice: StateCreator<AppState, [], [], TaskSlice> = (set, get) => ({
  tasks: {},
  loadTasks: async (includeArchived) => {
    try {
      const show = includeArchived ?? get().showArchivedTasks
      const tasks = await fetchTasks(show)
      setIfChanged<AppState>(set, 'tasks', tasks)
    } catch (err) {
      console.warn('Store error:', err)
    }
  },
  optimisticUpdateTask: async (taskId, patch) => {
    const prev = get().tasks[taskId]
    if (!prev) return false
    invalidateFingerprint('tasks')
    set({ tasks: { ...get().tasks, [taskId]: { ...prev, ...patch, updatedAt: Date.now() } } })
    try {
      await api('PUT', `/tasks/${taskId}`, patch)
      return true
    } catch {
      invalidateFingerprint('tasks')
      set({ tasks: { ...get().tasks, [taskId]: prev } })
      return false
    }
  },
  optimisticDeleteTask: async (taskId) => {
    const prev = get().tasks[taskId]
    if (!prev) return false
    const next = { ...get().tasks }
    delete next[taskId]
    invalidateFingerprint('tasks')
    set({ tasks: next })
    try {
      await api('DELETE', `/tasks/${taskId}`)
      return true
    } catch {
      invalidateFingerprint('tasks')
      set({ tasks: { ...get().tasks, [taskId]: prev } })
      return false
    }
  },
  showArchivedTasks: false,
  setShowArchivedTasks: (show) => {
    set({ showArchivedTasks: show })
    get().loadTasks(show)
  }
})
