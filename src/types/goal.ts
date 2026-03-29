export type GoalLevel = 'organization' | 'team' | 'project' | 'agent' | 'task'

export type GoalStatus = 'active' | 'achieved' | 'abandoned'

export interface Goal {
  id: string
  title: string
  description?: string
  level: GoalLevel
  parentGoalId?: string | null
  /** Link to a project (for project-level goals). */
  projectId?: string | null
  /** Link to an agent (for agent-level goals). */
  agentId?: string | null
  /** Link to a task (for task-level goals). */
  taskId?: string | null
  /** The concrete objective this goal achieves. */
  objective: string
  /** Constraints or guardrails on how the goal should be pursued. */
  constraints?: string[]
  /** How success is measured. */
  successMetric?: string | null
  /** Optional budget cap for this goal (USD). */
  budgetUsd?: number | null
  /** Optional deadline. */
  deadlineAt?: number | null
  status: GoalStatus
  createdAt: number
  updatedAt: number
}
