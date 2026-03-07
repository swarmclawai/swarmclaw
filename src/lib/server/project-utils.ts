import fs from 'fs'
import path from 'path'
import type { OrchestratorSecret, Project, Schedule, Skill, BoardTask } from '@/types'
import { WORKSPACE_DIR } from './data-dir'
import { loadSchedules, loadSecrets, loadSkills, loadTasks } from './storage'

function normalizeText(value: unknown, maxLen = 400): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.replace(/\s+/g, ' ').trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, maxLen)
}

function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, 32)
}

function normalizeStringArray(value: unknown, maxItems = 8, maxLen = 160): string[] | undefined {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\r?\n|[,;]+/)
      : []
  const items = rawItems
    .map((entry) => typeof entry === 'string' ? entry.replace(/\s+/g, ' ').trim() : '')
    .filter(Boolean)
    .slice(0, maxItems)
    .map((entry) => entry.slice(0, maxLen))
  return items.length > 0 ? items : undefined
}

function normalizeInteger(value: unknown, min: number, max: number): number | undefined {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return undefined
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export function normalizeProjectCreateInput(input: Record<string, unknown>): Omit<Project, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: normalizeText(input.name, 140) || 'Unnamed Project',
    description: normalizeText(input.description, 4000) || '',
    color: normalizeColor(input.color),
    objective: normalizeText(input.objective, 240),
    audience: normalizeText(input.audience, 240),
    priorities: normalizeStringArray(input.priorities, 10),
    openObjectives: normalizeStringArray(input.openObjectives, 12),
    capabilityHints: normalizeStringArray(input.capabilityHints, 12),
    credentialRequirements: normalizeStringArray(input.credentialRequirements, 12),
    successMetrics: normalizeStringArray(input.successMetrics, 10),
    heartbeatPrompt: normalizeText(input.heartbeatPrompt, 300),
    heartbeatIntervalSec: normalizeInteger(input.heartbeatIntervalSec, 0, 86_400),
  }
}

export function normalizeProjectPatchInput(input: Record<string, unknown>): Partial<Project> {
  const patch: Partial<Project> = {}

  if ('name' in input) patch.name = normalizeText(input.name, 140) || 'Unnamed Project'
  if ('description' in input) patch.description = normalizeText(input.description, 4000) || ''
  if ('color' in input) patch.color = normalizeColor(input.color)
  if ('objective' in input) patch.objective = normalizeText(input.objective, 240)
  if ('audience' in input) patch.audience = normalizeText(input.audience, 240)
  if ('priorities' in input) patch.priorities = normalizeStringArray(input.priorities, 10) || []
  if ('openObjectives' in input) patch.openObjectives = normalizeStringArray(input.openObjectives, 12) || []
  if ('capabilityHints' in input) patch.capabilityHints = normalizeStringArray(input.capabilityHints, 12) || []
  if ('credentialRequirements' in input) patch.credentialRequirements = normalizeStringArray(input.credentialRequirements, 12) || []
  if ('successMetrics' in input) patch.successMetrics = normalizeStringArray(input.successMetrics, 10) || []
  if ('heartbeatPrompt' in input) patch.heartbeatPrompt = normalizeText(input.heartbeatPrompt, 300)
  if ('heartbeatIntervalSec' in input) patch.heartbeatIntervalSec = normalizeInteger(input.heartbeatIntervalSec, 0, 86_400)

  return patch
}

export function projectWorkspaceRoot(projectId: string): string {
  return path.join(WORKSPACE_DIR, 'projects', projectId)
}

export function ensureProjectWorkspace(projectId: string, projectName?: string): string {
  const root = projectWorkspaceRoot(projectId)
  fs.mkdirSync(root, { recursive: true })
  const readmePath = path.join(root, 'README.md')
  if (!fs.existsSync(readmePath)) {
    const title = (projectName || 'Project Workspace').trim() || 'Project Workspace'
    fs.writeFileSync(readmePath, `# ${title}\n\nThis workspace belongs to project ${projectId}.\n`, 'utf8')
  }
  return root
}

export interface ProjectResourceSummary {
  openTaskCount: number
  queuedTaskCount: number
  runningTaskCount: number
  activeScheduleCount: number
  secretCount: number
  skillCount: number
  topTaskTitles: string[]
  scheduleNames: string[]
  secretNames: string[]
}

function byUpdatedDesc<T extends { updatedAt?: number; createdAt?: number }>(a: T, b: T): number {
  return (Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
}

export function summarizeProjectResources(projectId: string): ProjectResourceSummary {
  const tasks = Object.values(loadTasks() as Record<string, BoardTask>)
    .filter((task) => task?.projectId === projectId)
  const schedules = Object.values(loadSchedules() as Record<string, Schedule>)
    .filter((schedule) => schedule?.projectId === projectId)
  const secrets = Object.values(loadSecrets() as Record<string, OrchestratorSecret & { projectId?: string }>)
    .filter((secret) => secret?.projectId === projectId)
  const skills = Object.values(loadSkills() as Record<string, Skill>)
    .filter((skill) => skill?.projectId === projectId)

  const openTasks = tasks
    .filter((task) => ['backlog', 'queued', 'running'].includes(String(task.status || '').toLowerCase()))
    .sort(byUpdatedDesc)
  const activeSchedules = schedules
    .filter((schedule) => String(schedule.status || '').toLowerCase() === 'active')
    .sort(byUpdatedDesc)
  const recentSecrets = secrets
    .slice()
    .sort(byUpdatedDesc)

  return {
    openTaskCount: openTasks.length,
    queuedTaskCount: openTasks.filter((task) => task.status === 'queued').length,
    runningTaskCount: openTasks.filter((task) => task.status === 'running').length,
    activeScheduleCount: activeSchedules.length,
    secretCount: secrets.length,
    skillCount: skills.length,
    topTaskTitles: openTasks.slice(0, 3).map((task) => String(task.title || '').trim()).filter(Boolean),
    scheduleNames: activeSchedules.slice(0, 3).map((schedule) => String(schedule.name || '').trim()).filter(Boolean),
    secretNames: recentSecrets.slice(0, 3).map((secret) => String(secret.name || '').trim()).filter(Boolean),
  }
}

export function buildProjectSnapshot(project: Project): Project & {
  workspaceRoot: string
  resourceSummary: ProjectResourceSummary
} {
  return {
    ...project,
    workspaceRoot: ensureProjectWorkspace(project.id, project.name),
    resourceSummary: summarizeProjectResources(project.id),
  }
}
