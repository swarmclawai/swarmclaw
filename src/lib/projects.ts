import { api } from './api-client'
import type { Project } from '../types'

export const fetchProjects = () => api<Record<string, Project>>('GET', '/projects')

export const createProject = (data: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>) =>
  api<Project>('POST', '/projects', data)

export const updateProject = (id: string, data: Partial<Project>) =>
  api<Project>('PUT', `/projects/${id}`, data)

export const deleteProject = (id: string) =>
  api<string>('DELETE', `/projects/${id}`)
