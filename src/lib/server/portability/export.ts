import { loadAgents } from '@/lib/server/agents/agent-repository'
import { loadSkills } from '@/lib/server/skills/skill-repository'
import { loadSchedules } from '@/lib/server/schedules/schedule-repository'
import type { Agent } from '@/types/agent'
import type { Skill } from '@/types/skill'
import type { Schedule } from '@/types/schedule'

export const PORTABILITY_FORMAT_VERSION = 1

export interface PortableManifest {
  formatVersion: number
  exportedAt: string
  agents: PortableAgent[]
  skills: PortableSkill[]
  schedules: PortableSchedule[]
}

export type PortableAgent = Omit<Agent,
  // Strip runtime/sensitive fields
  | 'id' | 'credentialId' | 'fallbackCredentialIds' | 'apiEndpoint'
  | 'threadSessionId' | 'lastUsedAt' | 'totalCost' | 'trashedAt'
  | 'openclawAgentId' | 'gatewayProfileId' | 'avatarUrl'
> & {
  /** Original ID — used for matching during import */
  originalId: string
}

export type PortableSkill = Pick<Skill,
  | 'name' | 'content' | 'description' | 'tags' | 'scope'
  | 'author' | 'version' | 'primaryEnv' | 'capabilities'
  | 'toolNames' | 'frontmatter'
> & {
  originalId: string
}

export type PortableSchedule = Pick<Schedule,
  | 'name' | 'taskPrompt' | 'taskMode' | 'message' | 'description'
  | 'scheduleType' | 'frequency' | 'cron' | 'atTime' | 'intervalMs'
  | 'timezone' | 'action' | 'path' | 'command'
> & {
  originalId: string
  /** Original agent ID — resolved to new ID during import */
  originalAgentId: string
}

/** Sensitive fields stripped from exported agents */
const AGENT_STRIP_KEYS: (keyof Agent)[] = [
  'id', 'credentialId', 'fallbackCredentialIds', 'apiEndpoint',
  'threadSessionId', 'lastUsedAt', 'totalCost', 'trashedAt',
  'openclawAgentId', 'gatewayProfileId', 'avatarUrl',
]

export function exportConfig(): PortableManifest {
  const agents = loadAgents()
  const skills = loadSkills()
  const schedules = loadSchedules()

  const portableAgents: PortableAgent[] = Object.values(agents)
    .filter((a) => !a.trashedAt && !a.disabled)
    .map((agent) => {
      const portable = { ...agent, originalId: agent.id } as Record<string, unknown>
      for (const key of AGENT_STRIP_KEYS) delete portable[key]
      return portable as PortableAgent
    })

  const portableSkills: PortableSkill[] = Object.values(skills).map((skill) => ({
    originalId: skill.id,
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

  const portableSchedules: PortableSchedule[] = Object.values(schedules)
    .filter((s) => s.status !== 'archived')
    .map((schedule) => ({
      originalId: schedule.id,
      originalAgentId: schedule.agentId,
      name: schedule.name,
      taskPrompt: schedule.taskPrompt,
      taskMode: schedule.taskMode,
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

  return {
    formatVersion: PORTABILITY_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    agents: portableAgents,
    skills: portableSkills,
    schedules: portableSchedules,
  }
}
