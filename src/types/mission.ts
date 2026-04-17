export type MissionStatus =
  | 'draft'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'budget_exhausted'

export type MissionReportFormat = 'markdown' | 'slack' | 'discord' | 'email' | 'audio'

export type MissionMilestoneKind =
  | 'started'
  | 'budget_warn'
  | 'budget_hit'
  | 'check_in'
  | 'subgoal_done'
  | 'report_sent'
  | 'paused'
  | 'resumed'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface MissionBudget {
  maxUsd?: number | null
  maxTokens?: number | null
  maxToolCalls?: number | null
  maxWallclockSec?: number | null
  maxTurns?: number | null
  /**
   * Cap on concurrent sub-agent branches when this mission's agents fan out
   * via `spawn_subagent` swarm/batch actions. Overrides the system default
   * (4) when set. Hard-capped at 16 regardless.
   */
  maxParallelBranches?: number | null
  warnAtFractions?: number[]
}

export interface MissionUsage {
  usdSpent: number
  tokensUsed: number
  toolCallsUsed: number
  turnsRun: number
  wallclockMsElapsed: number
  startedAt: number | null
  lastUpdatedAt: number
  warnFractionsHit: number[]
}

export interface MissionMilestone {
  id: string
  at: number
  kind: MissionMilestoneKind
  summary: string
  evidence?: string[]
  sessionId?: string | null
  runId?: string | null
}

export interface MissionReportSchedule {
  intervalSec: number
  format: MissionReportFormat
  enabled: boolean
  lastReportAt?: number | null
}

export interface MissionReportDelivery {
  connectorId?: string | null
  channelId?: string | null
  deliveredAt: number
  status: 'ok' | 'error'
  error?: string | null
}

export interface MissionReport {
  id: string
  missionId: string
  generatedAt: number
  format: MissionReportFormat
  fromAt: number
  toAt: number
  title: string
  body: string
  audioUrl?: string | null
  deliveredTo: MissionReportDelivery[]
  highlights: Array<{ kind: string; summary: string; evidenceRunId?: string | null }>
}

export interface MissionEvent {
  id: string
  missionId: string
  at: number
  kind: string
  payload: Record<string, unknown>
  sessionId?: string | null
  runId?: string | null
}

export interface Mission {
  id: string
  title: string
  goal: string
  successCriteria: string[]
  rootSessionId: string
  agentIds: string[]
  status: MissionStatus
  budget: MissionBudget
  usage: MissionUsage
  milestones: MissionMilestone[]
  reportSchedule?: MissionReportSchedule | null
  reportConnectorIds: string[]
  createdAt: number
  updatedAt: number
  startedAt?: number | null
  endedAt?: number | null
  endReason?: string | null
  templateId?: string | null
  /** Optional reference to the goal this mission serves (Goal entity). */
  goalId?: string | null
  /** Cost attribution tags. Cost rolls up by code in addition to per-mission/per-agent. */
  billingCodes?: string[]
}

export const DEFAULT_MISSION_WARN_FRACTIONS = [0.5, 0.8, 0.95]
export const MISSION_MILESTONE_TAIL_CAP = 200

export type MissionTemplateCategory =
  | 'research'
  | 'communication'
  | 'monitoring'
  | 'productivity'
  | 'support'

export interface MissionTemplateDefaults {
  title: string
  goal: string
  successCriteria: string[]
  budget: MissionBudget
  reportSchedule: MissionReportSchedule | null
}

export interface MissionTemplate {
  id: string
  name: string
  description: string
  icon: string
  category: MissionTemplateCategory
  tags: string[]
  setupNote?: string | null
  defaults: MissionTemplateDefaults
}
