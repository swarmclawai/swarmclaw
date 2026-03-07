import path from 'path'
import type { Project } from '@/types'
import { WORKSPACE_DIR } from './data-dir'
import { loadAgents, loadProjects } from './storage'
import { buildProjectSnapshot, type ProjectResourceSummary } from './project-utils'

export interface ActiveProjectContext {
  projectId: string | null
  project: (Project & { workspaceRoot: string; resourceSummary: ProjectResourceSummary }) | null
  projectRoot: string | null
  objective: string | null
  audience: string | null
  priorities: string[]
  openObjectives: string[]
  capabilityHints: string[]
  credentialRequirements: string[]
  successMetrics: string[]
  heartbeatPrompt: string | null
  heartbeatIntervalSec: number | null
  resourceSummary: ProjectResourceSummary | null
}

function normalizeProjectId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function inferProjectIdFromCwd(cwd: unknown): string | null {
  if (typeof cwd !== 'string' || !cwd.trim()) return null
  const projectsRoot = path.resolve(path.join(WORKSPACE_DIR, 'projects'))
  const resolvedCwd = path.resolve(cwd)
  const relative = path.relative(projectsRoot, resolvedCwd)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  const [projectId] = relative.split(path.sep).filter(Boolean)
  return normalizeProjectId(projectId)
}

function extractProjectHints(project: Project | null): {
  objective: string | null
  audience: string | null
  priorities: string[]
  openObjectives: string[]
  capabilityHints: string[]
  credentialRequirements: string[]
  successMetrics: string[]
  heartbeatPrompt: string | null
  heartbeatIntervalSec: number | null
} {
  if (!project) {
    return {
      objective: null,
      audience: null,
      priorities: [],
      openObjectives: [],
      capabilityHints: [],
      credentialRequirements: [],
      successMetrics: [],
      heartbeatPrompt: null,
      heartbeatIntervalSec: null,
    }
  }
  if (
    project.objective
    || project.audience
    || project.priorities?.length
    || project.openObjectives?.length
    || project.capabilityHints?.length
    || project.credentialRequirements?.length
    || project.successMetrics?.length
    || project.heartbeatPrompt
    || typeof project.heartbeatIntervalSec === 'number'
  ) {
    return {
      objective: project.objective || null,
      audience: project.audience || null,
      priorities: Array.isArray(project.priorities) ? project.priorities : [],
      openObjectives: Array.isArray(project.openObjectives) ? project.openObjectives : [],
      capabilityHints: Array.isArray(project.capabilityHints) ? project.capabilityHints : [],
      credentialRequirements: Array.isArray(project.credentialRequirements) ? project.credentialRequirements : [],
      successMetrics: Array.isArray(project.successMetrics) ? project.successMetrics : [],
      heartbeatPrompt: project.heartbeatPrompt || null,
      heartbeatIntervalSec: typeof project.heartbeatIntervalSec === 'number' ? project.heartbeatIntervalSec : null,
    }
  }

  const description = project.description || ''
  if (!description) {
    return {
      objective: null,
      audience: null,
      priorities: [],
      openObjectives: [],
      capabilityHints: [],
      credentialRequirements: [],
      successMetrics: [],
      heartbeatPrompt: null,
      heartbeatIntervalSec: null,
    }
  }
  const audienceMatch = description.match(/\bfor\s+([^.!?]+?)(?:\.|,|;|$)/i)
  const objectiveMatch = description.match(/^([^.!?]+?)(?:\.|!|\?)/)
  const focusMatch = description.match(/\b(?:focused on|focuses on|pilot priorities(?: are| include)?|priority is)\s+([^.!?]+)/i)
  const audience = normalizeProjectId(audienceMatch?.[1]?.replace(/^the\s+/i, '').trim()) || null
  const priorities = (focusMatch?.[1] || '')
    .split(/\s+(?:and|&)\s+|,\s+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, 4)
  return {
    objective: normalizeProjectId(objectiveMatch?.[1]?.trim()) || null,
    audience,
    priorities,
    openObjectives: [],
    capabilityHints: [],
    credentialRequirements: [],
    successMetrics: [],
    heartbeatPrompt: null,
    heartbeatIntervalSec: null,
  }
}

export function resolveActiveProjectContext(sessionLike: { agentId?: string | null; cwd?: string | null; projectId?: string | null }): ActiveProjectContext {
  const agents = loadAgents()
  const projects = loadProjects() as Record<string, Project>
  const explicitProjectId = normalizeProjectId(sessionLike.projectId)
  const agentProjectId = normalizeProjectId(sessionLike.agentId ? agents[sessionLike.agentId]?.projectId : null)
  const cwdProjectId = inferProjectIdFromCwd(sessionLike.cwd)
  const projectId = explicitProjectId || agentProjectId || cwdProjectId
  if (!projectId) {
    return {
      projectId: null,
      project: null,
      projectRoot: null,
      objective: null,
      audience: null,
      priorities: [],
      openObjectives: [],
      capabilityHints: [],
      credentialRequirements: [],
      successMetrics: [],
      heartbeatPrompt: null,
      heartbeatIntervalSec: null,
      resourceSummary: null,
    }
  }
  const project = projects[projectId] ? buildProjectSnapshot(projects[projectId]) : null
  const hints = extractProjectHints(project)
  return {
    projectId,
    project,
    projectRoot: project?.workspaceRoot || path.join(WORKSPACE_DIR, 'projects', projectId),
    objective: hints.objective,
    audience: hints.audience,
    priorities: hints.priorities,
    openObjectives: hints.openObjectives,
    capabilityHints: hints.capabilityHints,
    credentialRequirements: hints.credentialRequirements,
    successMetrics: hints.successMetrics,
    heartbeatPrompt: hints.heartbeatPrompt,
    heartbeatIntervalSec: hints.heartbeatIntervalSec,
    resourceSummary: project?.resourceSummary || null,
  }
}
