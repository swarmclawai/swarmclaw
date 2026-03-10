import type { Skill } from '@/types'
import { expandPluginIds } from '@/lib/server/tool-aliases'
import type { DiscoveredSkill } from './skill-discovery'

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function collectPluginMatchedDiscoveredSkills(
  discoveredSkills: DiscoveredSkill[],
  enabledPlugins: string[],
  storedSkills: Record<string, Skill>,
): { matched: DiscoveredSkill[]; remaining: DiscoveredSkill[] } {
  const pluginKeys = new Set(
    expandPluginIds(enabledPlugins)
      .map((pluginId) => normalizeKey(pluginId))
      .filter(Boolean),
  )
  const storedSkillKeys = new Set(
    Object.values(storedSkills)
      .map((skill) => normalizeKey(skill.name || ''))
      .filter(Boolean),
  )

  const matched: DiscoveredSkill[] = []
  const remaining: DiscoveredSkill[] = []

  for (const skill of discoveredSkills) {
    const key = normalizeKey(skill.name)
    if (pluginKeys.has(key) && !storedSkillKeys.has(key)) matched.push(skill)
    else remaining.push(skill)
  }

  return { matched, remaining }
}

export function buildDiscoveredSkillPromptText(skills: Pick<DiscoveredSkill, 'name' | 'content'>[]): string {
  const usableSkills = skills.filter((skill) => typeof skill.content === 'string' && skill.content.trim())
  if (usableSkills.length === 0) return ''

  const body = usableSkills
    .map((skill) => `### ${skill.name}\n${skill.content}`)
    .join('\n\n')

  return [
    '## Plugin Skills',
    'When a plugin-specific skill is present below, follow it before falling back to generic tool use.',
    'Prefer the exact command patterns and safety rules in the skill when using the matching plugin.',
    '',
    body,
  ].join('\n')
}
