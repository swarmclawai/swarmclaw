import type { Goal, GoalLevel } from '@/types'
import { genId } from '@/lib/id'
import { listGoals, getGoal, saveGoal, removeGoal } from './goal-repository'
import { logActivity } from '@/lib/server/activity/activity-log'
import { notify } from '@/lib/server/ws-hub'

export function getAllGoals(): Goal[] {
  return Object.values(listGoals())
}

export function getGoalById(id: string): Goal | null {
  return getGoal(id)
}

export function createGoal(input: {
  title: string
  description?: string
  level: GoalLevel
  parentGoalId?: string | null
  projectId?: string | null
  agentId?: string | null
  taskId?: string | null
  objective: string
  constraints?: string[]
  successMetric?: string | null
  budgetUsd?: number | null
  deadlineAt?: number | null
}): Goal {
  const id = genId()
  const now = Date.now()
  const goal: Goal = {
    id,
    title: input.title,
    description: input.description,
    level: input.level,
    parentGoalId: input.parentGoalId ?? null,
    projectId: input.projectId ?? null,
    agentId: input.agentId ?? null,
    taskId: input.taskId ?? null,
    objective: input.objective,
    constraints: input.constraints ?? [],
    successMetric: input.successMetric ?? null,
    budgetUsd: input.budgetUsd ?? null,
    deadlineAt: input.deadlineAt ?? null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }
  saveGoal(id, goal)
  logActivity({ entityType: 'task', entityId: id, action: 'created', actor: 'user', summary: `Goal created: "${goal.title}" (${goal.level})` })
  notify('goals')
  return goal
}

export function updateGoal(id: string, updates: Partial<Omit<Goal, 'id' | 'createdAt'>>): Goal | null {
  const existing = getGoal(id)
  if (!existing) return null
  const updated: Goal = {
    ...existing,
    ...updates,
    id,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  }
  saveGoal(id, updated)
  logActivity({ entityType: 'task', entityId: id, action: 'updated', actor: 'user', summary: `Goal updated: "${updated.title}"` })
  notify('goals')
  return updated
}

export function deleteGoal(id: string): boolean {
  const existing = getGoal(id)
  if (!existing) return false
  removeGoal(id)
  logActivity({ entityType: 'task', entityId: id, action: 'deleted', actor: 'user', summary: `Goal deleted: "${existing.title}"` })
  notify('goals')
  return true
}

/**
 * Walk the goal hierarchy to build a "why chain" from a specific goal up to the organization root.
 * Returns goals in order from most specific to most general.
 */
export function getGoalChain(goalId: string): Goal[] {
  const chain: Goal[] = []
  const visited = new Set<string>()
  let currentId: string | null | undefined = goalId
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const goal = getGoal(currentId)
    if (!goal) break
    chain.push(goal)
    currentId = goal.parentGoalId
  }
  return chain
}

/**
 * Resolve the effective goal for a given context by walking the hierarchy:
 * task goal → agent goal → project goal → organization default.
 */
export function resolveEffectiveGoal(context: {
  taskId?: string | null
  agentId?: string | null
  projectId?: string | null
}): Goal | null {
  const goals = getAllGoals().filter((g) => g.status === 'active')

  // 1. Task-level goal
  if (context.taskId) {
    const taskGoal = goals.find((g) => g.taskId === context.taskId)
    if (taskGoal) return taskGoal
  }

  // 2. Agent-level goal
  if (context.agentId) {
    const agentGoal = goals.find((g) => g.level === 'agent' && g.agentId === context.agentId)
    if (agentGoal) return agentGoal
  }

  // 3. Project-level goal
  if (context.projectId) {
    const projectGoal = goals.find((g) => g.level === 'project' && g.projectId === context.projectId)
    if (projectGoal) return projectGoal
  }

  // 4. Organization default
  const orgGoal = goals.find((g) => g.level === 'organization')
  return orgGoal ?? null
}

/**
 * Format a goal chain as a concise text block for injection into agent execution briefs.
 */
export function formatGoalChainForBrief(chain: Goal[]): string {
  if (chain.length === 0) return ''
  const lines = chain.map((g, i) => {
    const indent = '  '.repeat(i)
    const label = g.level.charAt(0).toUpperCase() + g.level.slice(1)
    return `${indent}${label}: ${g.title} — ${g.objective}`
  })
  return `Goal alignment:\n${lines.join('\n')}`
}
