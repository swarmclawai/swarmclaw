import type { Skill } from '@/types'
import { evaluateSkillEligibility } from '@/lib/server/skills/skill-eligibility'

/** Maximum number of skills injected into the system prompt. */
export const MAX_SKILLS_IN_PROMPT = 150

/** Maximum total characters of skill content in the system prompt. */
export const MAX_SKILLS_PROMPT_CHARS = 30_000

export interface BudgetedSkill {
  skill: Skill
  eligible: boolean
  included: boolean
  reason?: string
}

/**
 * Filter and budget skills for prompt injection.
 * Priority order:
 *   1. Agent-bound skills (skillIds) — always first
 *   2. `always: true` skills — global skills marked as always-on
 *   3. Other eligible skills — sorted by name
 *
 * Skills are filtered by eligibility (requirements met) and then by budget
 * (count and character limits).
 */
export function budgetSkillsForPrompt(
  skills: Record<string, Skill>,
  agentSkillIds: string[],
): BudgetedSkill[] {
  const results: BudgetedSkill[] = []
  const included: BudgetedSkill[] = []
  let totalChars = 0

  // Sort skills into priority buckets
  const agentBound: Skill[] = []
  const alwaysOn: Skill[] = []
  const rest: Skill[] = []

  for (const skillId of agentSkillIds) {
    const skill = skills[skillId]
    if (skill) agentBound.push(skill)
  }

  for (const skill of Object.values(skills)) {
    if (agentSkillIds.includes(skill.name || '')) continue
    if (skill.always) alwaysOn.push(skill)
    else rest.push(skill)
  }

  // Sort non-agent skills by name for deterministic ordering
  alwaysOn.sort((a, b) => a.name.localeCompare(b.name))
  rest.sort((a, b) => a.name.localeCompare(b.name))

  const orderedSkills = [...agentBound, ...alwaysOn, ...rest]

  for (const skill of orderedSkills) {
    const eligibility = evaluateSkillEligibility(skill)

    if (!eligibility.eligible) {
      results.push({ skill, eligible: false, included: false, reason: eligibility.reasons[0] })
      continue
    }

    const contentLen = (skill.content || '').length + (skill.name || '').length + 12 // "## Skill: " prefix
    if (included.length >= MAX_SKILLS_IN_PROMPT) {
      results.push({ skill, eligible: true, included: false, reason: 'skill count limit reached' })
      continue
    }

    if (totalChars + contentLen > MAX_SKILLS_PROMPT_CHARS) {
      results.push({ skill, eligible: true, included: false, reason: 'character budget exceeded' })
      continue
    }

    totalChars += contentLen
    const entry: BudgetedSkill = { skill, eligible: true, included: true }
    results.push(entry)
    included.push(entry)
  }

  return results
}

/**
 * Prescriptive skill adherence header.
 * This tells the model exactly when and how to use skills — the key difference
 * vs OpenClaw's superior skill following (1-2 tool calls vs 3-5).
 */
const SKILL_ADHERENCE_HEADER = `## Skills

Before responding, scan the skills listed below.
- If exactly one skill clearly applies to the user's request: follow its instructions directly.
- If multiple skills could apply: choose the most specific one, then follow it.
- If no skill applies: use your general tools (web search, shell, files, etc.) as normal.

When following a skill:
- Execute the skill's recommended commands or approach first, before falling back to generic tools.
- Prefer the skill's specific tool/command (e.g. \`curl wttr.in\` for weather) over generic web search.
- Aim for minimal tool calls — combine steps where possible.
- Respect rate limits: prefer fewer, larger operations over many small ones.

Available skills:`

/**
 * Build the prompt text for included skills, respecting budget limits.
 * Returns the text to inject into the system prompt.
 */
export function buildSkillPromptText(
  skills: Record<string, Skill>,
  agentSkillIds: string[],
): string {
  const budgeted = budgetSkillsForPrompt(skills, agentSkillIds)
  const skillParts: string[] = []

  for (const entry of budgeted) {
    if (!entry.included) continue
    if (!entry.skill.content) continue
    skillParts.push(`### ${entry.skill.name}\n${entry.skill.content}`)
  }

  if (skillParts.length === 0) return ''

  return `${SKILL_ADHERENCE_HEADER}\n\n${skillParts.join('\n\n')}`
}
