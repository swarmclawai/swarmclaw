import { genId } from '@/lib/id'
import { loadAgents, saveAgents } from '@/lib/server/agents/agent-repository'
import { loadSkills, saveSkill } from '@/lib/server/skills/skill-repository'
import { loadSchedules, upsertSchedule } from '@/lib/server/schedules/schedule-repository'
import { logActivity } from '@/lib/server/activity/activity-log'
import type { Agent } from '@/types/agent'
import type { Skill } from '@/types/skill'
import type { Schedule } from '@/types/schedule'
import type { PortableManifest, PortableAgent, PortableSkill, PortableSchedule } from './export'
import { PORTABILITY_FORMAT_VERSION } from './export'

export interface ImportResult {
  agents: { created: number; skipped: number; names: string[] }
  skills: { created: number; skipped: number; names: string[] }
  schedules: { created: number; skipped: number; names: string[] }
  /** Maps original IDs to new IDs for reference */
  idMap: Record<string, string>
}

function deduplicateName(name: string, existingNames: Set<string>): string {
  if (!existingNames.has(name)) return name
  let suffix = 2
  while (existingNames.has(`${name} (${suffix})`)) suffix++
  return `${name} (${suffix})`
}

export function importConfig(manifest: PortableManifest): ImportResult {
  if (manifest.formatVersion > PORTABILITY_FORMAT_VERSION) {
    throw new Error(`Unsupported format version ${manifest.formatVersion} (max supported: ${PORTABILITY_FORMAT_VERSION})`)
  }

  const idMap: Record<string, string> = {}
  const result: ImportResult = {
    agents: { created: 0, skipped: 0, names: [] },
    skills: { created: 0, skipped: 0, names: [] },
    schedules: { created: 0, skipped: 0, names: [] },
    idMap,
  }

  // --- Import skills first (agents may reference them) ---
  const existingSkills = loadSkills()
  const existingSkillNames = new Set(Object.values(existingSkills).map((s) => s.name))

  for (const portable of manifest.skills) {
    const name = deduplicateName(portable.name, existingSkillNames)
    const id = genId()
    idMap[portable.originalId] = id
    existingSkillNames.add(name)

    const skill: Skill = {
      id,
      name,
      filename: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`,
      content: portable.content,
      description: portable.description,
      tags: portable.tags,
      scope: portable.scope || 'global',
      author: portable.author,
      version: portable.version,
      primaryEnv: portable.primaryEnv,
      capabilities: portable.capabilities,
      toolNames: portable.toolNames,
      frontmatter: portable.frontmatter,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    saveSkill(id, skill)
    result.skills.created++
    result.skills.names.push(name)
  }

  // --- Import agents ---
  const existingAgents = loadAgents()
  const existingAgentNames = new Set(Object.values(existingAgents).map((a) => a.name))

  for (const portable of manifest.agents) {
    const name = deduplicateName(portable.name, existingAgentNames)
    const id = genId()
    const now = Date.now()
    idMap[portable.originalId] = id
    existingAgentNames.add(name)

    // Remap skill IDs if they were imported
    const remappedSkillIds = (portable.skillIds || []).map((sid) => idMap[sid] || sid)

    const agent: Agent = {
      ...(portable as Omit<PortableAgent, 'originalId'>),
      id,
      name,
      skillIds: remappedSkillIds,
      // Reset runtime fields
      threadSessionId: null,
      lastUsedAt: undefined,
      totalCost: undefined,
      trashedAt: undefined,
      credentialId: null,
      fallbackCredentialIds: [],
      apiEndpoint: null,
      createdAt: typeof portable.createdAt === 'number' ? portable.createdAt : now,
      updatedAt: now,
    }
    existingAgents[id] = agent
    result.agents.created++
    result.agents.names.push(name)
  }

  saveAgents(existingAgents)

  // --- Import schedules (need agent ID mapping) ---
  const existingSchedules = loadSchedules()
  const existingScheduleNames = new Set(Object.values(existingSchedules).map((s) => s.name))

  for (const portable of manifest.schedules) {
    const newAgentId = idMap[portable.originalAgentId]
    if (!newAgentId) {
      result.schedules.skipped++
      continue
    }

    const name = deduplicateName(portable.name, existingScheduleNames)
    const id = genId()
    idMap[portable.originalId] = id
    existingScheduleNames.add(name)

    const schedule: Schedule = {
      id,
      name,
      agentId: newAgentId,
      taskPrompt: portable.taskPrompt,
      taskMode: portable.taskMode,
      message: portable.message,
      description: portable.description,
      scheduleType: portable.scheduleType,
      frequency: portable.frequency,
      cron: portable.cron,
      atTime: portable.atTime,
      intervalMs: portable.intervalMs,
      timezone: portable.timezone,
      action: portable.action,
      path: portable.path,
      command: portable.command,
      status: 'paused',
      createdAt: Date.now(),
    }
    upsertSchedule(id, schedule)
    result.schedules.created++
    result.schedules.names.push(name)
  }

  logActivity({
    entityType: 'system',
    entityId: 'portability',
    action: 'imported',
    actor: 'user',
    summary: `Imported ${result.agents.created} agents, ${result.skills.created} skills, ${result.schedules.created} schedules`,
  })

  return result
}
