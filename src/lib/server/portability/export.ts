import { loadAgents } from '@/lib/server/agents/agent-repository'
import { loadSkills } from '@/lib/server/skills/skill-repository'
import { loadSchedules } from '@/lib/server/schedules/schedule-repository'
import { loadConnectors } from '@/lib/server/connectors/connector-repository'
import { loadChatrooms } from '@/lib/server/chatrooms/chatroom-repository'
import { loadMcpServers, loadProjects, loadGoals } from '@/lib/server/storage'
import { getExtensionManager } from '@/lib/server/extensions'
import type { Agent } from '@/types/agent'
import type { Skill } from '@/types/skill'
import type { Schedule } from '@/types/schedule'
import type { Connector } from '@/types/connector'
import type { Chatroom, McpServerConfig } from '@/types'
import type { Project } from '@/types'
import type { Goal } from '@/types/goal'
import type { ExtensionMeta } from '@/types/extension'

/**
 * Bumped to v2 to reflect the expanded surface (connectors, MCP servers,
 * chatrooms, projects, goals, extensions). Importer still accepts v1 manifests.
 */
export const PORTABILITY_FORMAT_VERSION = 2

export interface PortableManifest {
  formatVersion: number
  exportedAt: string
  scope?: PortableManifestScope
  agents: PortableAgent[]
  skills: PortableSkill[]
  schedules: PortableSchedule[]
  connectors?: PortableConnector[]
  chatrooms?: PortableChatroom[]
  mcpServers?: PortableMcpServer[]
  projects?: PortableProject[]
  goals?: PortableGoal[]
  extensions?: PortableExtensionRef[]
}

export type PortableManifestScope =
  | { kind: 'all' }
  | { kind: 'project'; originalProjectId: string; projectName: string }

export interface ExportConfigOptions {
  projectId?: string | null
}

function toSafeFilenameSegment(value: string): string {
  let segment = ''
  let lastWasDash = false
  for (const char of value.toLowerCase()) {
    const code = char.charCodeAt(0)
    const isLowerAlpha = code >= 97 && code <= 122
    const isDigit = code >= 48 && code <= 57
    if (isLowerAlpha || isDigit) {
      segment += char
      lastWasDash = false
    } else if (!lastWasDash && segment.length > 0) {
      segment += '-'
      lastWasDash = true
    }
  }
  return (lastWasDash ? segment.slice(0, -1) : segment) || 'project'
}

export function buildPortableExportFilename(
  manifest: Pick<PortableManifest, 'exportedAt' | 'scope'> = { exportedAt: new Date().toISOString() },
): string {
  const safeStamp = manifest.exportedAt
    .replaceAll(':', '')
    .replaceAll('.', '')
    .replaceAll('-', '')
    .replace('T', '-')
    .replace('Z', 'Z')
  if (manifest.scope?.kind === 'project') {
    return `swarmclaw-project-${toSafeFilenameSegment(manifest.scope.projectName)}-${safeStamp}.json`
  }
  return `swarmclaw-export-${safeStamp}.json`
}

export type PortableAgent = Omit<Agent,
  | 'id' | 'credentialId' | 'fallbackCredentialIds' | 'apiEndpoint'
  | 'threadSessionId' | 'lastUsedAt' | 'totalCost' | 'trashedAt'
  | 'openclawAgentId' | 'gatewayProfileId' | 'avatarUrl'
> & {
  originalId: string
}

export type PortableSkill = Pick<Skill,
  | 'name' | 'content' | 'description' | 'tags' | 'scope'
  | 'author' | 'version' | 'primaryEnv' | 'capabilities'
  | 'toolNames' | 'frontmatter'
> & {
  originalId: string
  originalProjectId?: string | null
  originalAgentIds?: string[]
}

export type PortableSchedule = Pick<Schedule,
  | 'name' | 'taskPrompt' | 'taskMode' | 'message' | 'description'
  | 'scheduleType' | 'frequency' | 'cron' | 'atTime' | 'intervalMs'
  | 'timezone' | 'action' | 'path' | 'command' | 'projectId'
  | 'protocolTemplateId' | 'protocolParticipantAgentIds'
  | 'protocolFacilitatorAgentId' | 'protocolObserverAgentIds'
  | 'protocolConfig'
> & {
  originalId: string
  originalAgentId: string
}

export type PortableConnector = Pick<Connector,
  'name' | 'platform' | 'isEnabled'
> & {
  originalId: string
  originalAgentId?: string | null
  originalChatroomId?: string | null
  /** Non-secret config fields. Credential IDs and tokens are scrubbed. */
  config: Record<string, string>
  /** Marker so importer knows credentials must be re-added. */
  credentialsScrubbed: true
}

export type PortableChatroom = Pick<Chatroom,
  | 'name' | 'description' | 'chatMode' | 'autoAddress'
  | 'routingGuidance' | 'temporary' | 'topic'
> & {
  originalId: string
  originalAgentIds: string[]
  routingRules?: Array<{
    type: 'keyword' | 'capability'
    pattern?: string
    keywords?: string[]
    originalAgentId: string
    priority: number
  }>
}

export type PortableMcpServer = Pick<McpServerConfig,
  | 'name' | 'transport' | 'command' | 'args' | 'cwd' | 'url'
> & {
  originalId: string
  /** Env keys preserved, values scrubbed. */
  envKeys?: string[]
  headerKeys?: string[]
  credentialsScrubbed: true
}

export type PortableProject = Pick<Project,
  | 'name' | 'description' | 'color' | 'objective' | 'audience'
  | 'priorities' | 'openObjectives' | 'capabilityHints'
  | 'credentialRequirements' | 'successMetrics'
  | 'heartbeatPrompt' | 'heartbeatIntervalSec'
> & {
  originalId: string
}

export type PortableGoal = Pick<Goal,
  | 'title' | 'description' | 'level' | 'objective' | 'constraints'
  | 'successMetric' | 'budgetUsd' | 'deadlineAt' | 'status'
> & {
  originalId: string
  originalParentGoalId?: string | null
  originalProjectId?: string | null
  originalAgentId?: string | null
}

export type PortableExtensionRef = Pick<ExtensionMeta,
  | 'name' | 'filename' | 'enabled' | 'isBuiltin' | 'author'
  | 'version' | 'source' | 'sourceUrl' | 'installSource'
>

const AGENT_STRIP_KEYS: (keyof Agent)[] = [
  'id', 'credentialId', 'fallbackCredentialIds', 'apiEndpoint',
  'threadSessionId', 'lastUsedAt', 'totalCost', 'trashedAt',
  'openclawAgentId', 'gatewayProfileId', 'avatarUrl',
]

const SECRET_KEY_PATTERN = /(token|key|secret|password|credential|auth|bearer|apikey)/i

function scrubSecretValues(obj: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!obj) return out
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_KEY_PATTERN.test(key)) continue
    if (typeof value === 'string') out[key] = value
    else if (value != null) out[key] = String(value)
  }
  return out
}

function scheduleAgentRefs(schedule: Schedule): string[] {
  return [
    schedule.agentId,
    ...(schedule.protocolParticipantAgentIds || []),
    ...(schedule.protocolObserverAgentIds || []),
    ...(schedule.protocolFacilitatorAgentId ? [schedule.protocolFacilitatorAgentId] : []),
  ]
}

function chatroomAgentRefs(chatroom: Chatroom): string[] {
  return [
    ...(chatroom.agentIds || []),
    ...(chatroom.routingRules || []).map((rule) => rule.agentId),
  ]
}

function hasAnyRef(ids: Iterable<string | null | undefined>, includedIds: Set<string>): boolean {
  for (const id of ids) {
    if (id && includedIds.has(id)) return true
  }
  return false
}

function includeGoalAncestors(goals: Record<string, Goal>, includedGoalIds: Set<string>): void {
  let changed = true
  while (changed) {
    changed = false
    for (const goalId of [...includedGoalIds]) {
      const parentGoalId = goals[goalId]?.parentGoalId
      if (parentGoalId && goals[parentGoalId] && !includedGoalIds.has(parentGoalId)) {
        includedGoalIds.add(parentGoalId)
        changed = true
      }
    }
  }
}

function createProjectScope(
  options: ExportConfigOptions,
  agents: Record<string, Agent>,
  schedules: Record<string, Schedule>,
  chatrooms: Record<string, Chatroom>,
  connectors: Record<string, Connector>,
  mcpServers: Record<string, McpServerConfig>,
  projects: Record<string, Project>,
  goals: Record<string, Goal>,
) {
  const requestedProjectId = options.projectId?.trim() || null
  if (!requestedProjectId) {
    return {
      scope: { kind: 'all' } as PortableManifestScope,
      agentIds: null,
      skillIds: null,
      scheduleIds: null,
      connectorIds: null,
      chatroomIds: null,
      mcpServerIds: null,
      projectIds: null,
      goalIds: null,
    }
  }

  const project = projects[requestedProjectId]
  if (!project) throw new Error(`Project not found: ${requestedProjectId}`)

  const activeSchedules = Object.values(schedules).filter((schedule) => schedule.status !== 'archived')
  const projectSchedules = activeSchedules.filter((schedule) => schedule.projectId === requestedProjectId)
  const agentIds = new Set(
    Object.values(agents)
      .filter((agent) => !agent.trashedAt && !agent.disabled && agent.projectId === requestedProjectId)
      .map((agent) => agent.id),
  )
  for (const schedule of projectSchedules) {
    for (const agentId of scheduleAgentRefs(schedule)) {
      if (agents[agentId] && !agents[agentId].trashedAt && !agents[agentId].disabled) {
        agentIds.add(agentId)
      }
    }
  }

  const scheduleIds = new Set(
    activeSchedules
      .filter((schedule) => {
        if (schedule.projectId === requestedProjectId) return agentIds.has(schedule.agentId)
        if (schedule.projectId) return false
        return hasAnyRef(scheduleAgentRefs(schedule), agentIds)
      })
      .map((schedule) => schedule.id),
  )

  const skillIds = new Set<string>()
  for (const agentId of agentIds) {
    for (const skillId of agents[agentId]?.skillIds || []) skillIds.add(skillId)
  }
  const mcpServerIds = new Set<string>()
  for (const agentId of agentIds) {
    for (const serverId of agents[agentId]?.mcpServerIds || []) {
      if (mcpServers[serverId]) mcpServerIds.add(serverId)
    }
  }

  const projectIds = new Set([requestedProjectId])
  const chatroomIds = new Set(
    Object.values(chatrooms)
      .filter((chatroom) => !chatroom.archivedAt && !chatroom.temporary && hasAnyRef(chatroomAgentRefs(chatroom), agentIds))
      .map((chatroom) => chatroom.id),
  )
  const connectorIds = new Set(
    Object.values(connectors)
      .filter((connector) => {
        if (connector.agentId && agentIds.has(connector.agentId)) return true
        if (connector.chatroomId && chatroomIds.has(connector.chatroomId)) return true
        return false
      })
      .map((connector) => connector.id),
  )
  const goalIds = new Set(
    Object.values(goals)
      .filter((goal) => goal.projectId === requestedProjectId || (goal.agentId ? agentIds.has(goal.agentId) : false))
      .map((goal) => goal.id),
  )
  includeGoalAncestors(goals, goalIds)

  return {
    scope: { kind: 'project', originalProjectId: project.id, projectName: project.name } as PortableManifestScope,
    agentIds,
    skillIds,
    scheduleIds,
    connectorIds,
    chatroomIds,
    mcpServerIds,
    projectIds,
    goalIds,
  }
}

export function exportConfig(options: ExportConfigOptions = {}): PortableManifest {
  const agents = loadAgents()
  const skills = loadSkills()
  const schedules = loadSchedules()
  const connectors = loadConnectors()
  const chatrooms = loadChatrooms()
  const mcpServers = loadMcpServers() as Record<string, McpServerConfig>
  const projects = loadProjects() as Record<string, Project>
  const goals = loadGoals() as Record<string, Goal>
  const scope = createProjectScope(options, agents, schedules, chatrooms, connectors, mcpServers, projects, goals)

  const portableAgents: PortableAgent[] = Object.values(agents)
    .filter((a) => !a.trashedAt && !a.disabled)
    .filter((a) => !scope.agentIds || scope.agentIds.has(a.id))
    .map((agent) => {
      const portable = { ...agent, originalId: agent.id } as Record<string, unknown>
      for (const key of AGENT_STRIP_KEYS) delete portable[key]
      return portable as PortableAgent
    })

  const portableSkills: PortableSkill[] = Object.values(skills)
    .map((skill) => ({
      originalId: skill.id,
      originalProjectId: skill.projectId ?? null,
      originalAgentIds: skill.agentIds ? [...skill.agentIds] : undefined,
      name: skill.name,
      content: skill.content,
      description: skill.description,
      tags: skill.tags,
      scope: skill.scope,
      author: skill.author,
      version: skill.version,
      primaryEnv: skill.primaryEnv,
      capabilities: skill.capabilities,
      toolNames: skill.toolNames,
      frontmatter: skill.frontmatter,
    }))
    .filter((skill) => {
      if (!scope.skillIds) return true
      const scopedProjectId = scope.scope.kind === 'project' ? scope.scope.originalProjectId : null
      if (scopedProjectId && skill.originalProjectId === scopedProjectId) return true
      if (skill.originalAgentIds && scope.agentIds && hasAnyRef(skill.originalAgentIds, scope.agentIds)) return true
      return scope.skillIds.has(skill.originalId)
    })

  const portableSchedules: PortableSchedule[] = Object.values(schedules)
    .filter((s) => s.status !== 'archived')
    .filter((s) => !scope.scheduleIds || scope.scheduleIds.has(s.id))
    .map((schedule) => ({
      originalId: schedule.id,
      originalAgentId: schedule.agentId,
      projectId: schedule.projectId,
      name: schedule.name,
      taskPrompt: schedule.taskPrompt,
      taskMode: schedule.taskMode,
      protocolTemplateId: schedule.protocolTemplateId,
      protocolParticipantAgentIds: schedule.protocolParticipantAgentIds,
      protocolFacilitatorAgentId: schedule.protocolFacilitatorAgentId,
      protocolObserverAgentIds: schedule.protocolObserverAgentIds,
      protocolConfig: schedule.protocolConfig,
      message: schedule.message,
      description: schedule.description,
      scheduleType: schedule.scheduleType,
      frequency: schedule.frequency,
      cron: schedule.cron,
      atTime: schedule.atTime,
      intervalMs: schedule.intervalMs,
      timezone: schedule.timezone,
      action: schedule.action,
      path: schedule.path,
      command: schedule.command,
    }))

  const portableConnectors: PortableConnector[] = Object.values(connectors)
    .filter((c) => !scope.connectorIds || scope.connectorIds.has(c.id))
    .map((c) => ({
      originalId: c.id,
      originalAgentId: !scope.agentIds || (c.agentId && scope.agentIds.has(c.agentId)) ? c.agentId ?? null : null,
      originalChatroomId: c.chatroomId ?? null,
      name: c.name,
      platform: c.platform,
      isEnabled: false,
      config: scrubSecretValues(c.config),
      credentialsScrubbed: true,
    }))

  const portableChatrooms: PortableChatroom[] = Object.values(chatrooms)
    .filter((c) => !c.archivedAt && !c.temporary)
    .filter((c) => !scope.chatroomIds || scope.chatroomIds.has(c.id))
    .map((c) => ({
      originalId: c.id,
      originalAgentIds: scope.agentIds
        ? (c.agentIds || []).filter((agentId) => scope.agentIds?.has(agentId))
        : [...(c.agentIds || [])],
      name: c.name,
      description: c.description,
      chatMode: c.chatMode,
      autoAddress: c.autoAddress,
      routingGuidance: c.routingGuidance ?? null,
      temporary: c.temporary,
      topic: c.topic,
      routingRules: (c.routingRules || [])
        .filter((r) => !scope.agentIds || scope.agentIds.has(r.agentId))
        .map((r) => ({
          type: r.type,
          pattern: r.pattern,
          keywords: r.keywords,
          originalAgentId: r.agentId,
          priority: r.priority,
        })),
    }))

  const portableMcpServers: PortableMcpServer[] = Object.values(mcpServers)
    .filter((s) => !scope.mcpServerIds || scope.mcpServerIds.has(s.id))
    .map((s) => ({
    originalId: s.id,
    name: s.name,
    transport: s.transport,
    command: s.command,
    args: s.args,
    cwd: s.cwd,
    url: s.url,
    envKeys: s.env ? Object.keys(s.env) : undefined,
    headerKeys: s.headers ? Object.keys(s.headers) : undefined,
    credentialsScrubbed: true,
  }))

  const portableProjects: PortableProject[] = Object.values(projects)
    .filter((p) => !scope.projectIds || scope.projectIds.has(p.id))
    .map((p) => ({
    originalId: p.id,
    name: p.name,
    description: p.description,
    color: p.color,
    objective: p.objective,
    audience: p.audience,
    priorities: p.priorities,
    openObjectives: p.openObjectives,
    capabilityHints: p.capabilityHints,
    credentialRequirements: p.credentialRequirements,
    successMetrics: p.successMetrics,
    heartbeatPrompt: p.heartbeatPrompt,
    heartbeatIntervalSec: p.heartbeatIntervalSec,
  }))

  const portableGoals: PortableGoal[] = Object.values(goals)
    .filter((g) => !scope.goalIds || scope.goalIds.has(g.id))
    .map((g) => ({
    originalId: g.id,
    originalParentGoalId: g.parentGoalId ?? null,
    originalProjectId: g.projectId ?? null,
    originalAgentId: g.agentId ?? null,
    title: g.title,
    description: g.description,
    level: g.level,
    objective: g.objective,
    constraints: g.constraints,
    successMetric: g.successMetric,
    budgetUsd: g.budgetUsd,
    deadlineAt: g.deadlineAt,
    status: g.status,
  }))

  const portableExtensions: PortableExtensionRef[] = (() => {
    try {
      const manager = getExtensionManager()
      return manager.listExtensions().map((m) => ({
        name: m.name,
        filename: m.filename,
        enabled: m.enabled,
        isBuiltin: m.isBuiltin,
        author: m.author,
        version: m.version,
        source: m.source,
        sourceUrl: m.sourceUrl,
        installSource: m.installSource,
      }))
    } catch {
      return []
    }
  })()

  return {
    formatVersion: PORTABILITY_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    scope: scope.scope,
    agents: portableAgents,
    skills: portableSkills,
    schedules: portableSchedules,
    connectors: portableConnectors,
    chatrooms: portableChatrooms,
    mcpServers: portableMcpServers,
    projects: portableProjects,
    goals: portableGoals,
    extensions: portableExtensions,
  }
}
