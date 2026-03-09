import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { budgetSkillsForPrompt, buildSkillPromptText, MAX_SKILLS_IN_PROMPT, MAX_SKILLS_PROMPT_CHARS } from './skill-prompt-budget'
import type { Skill } from '@/types'

function makeSkill(id: string, overrides: Partial<Skill> = {}): Skill {
  return { id: "test-skill-1",
    name: id,
    filename: `${id}.md`,
    content: overrides.content ?? `Instructions for ${id} skill.`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('budgetSkillsForPrompt', () => {
  it('includes agent-bound skills first', () => {
    const skills: Record<string, Skill> = {
      weather: makeSkill('weather'),
      github: makeSkill('github'),
      coding: makeSkill('coding'),
    }
    const result = budgetSkillsForPrompt(skills, ['weather', 'coding'])
    const included = result.filter((r) => r.included)
    assert.equal(included.length, 3) // weather, coding (agent-bound) + github (eligible)
    assert.equal(included[0].skill.name, 'weather')
    assert.equal(included[1].skill.name, 'coding')
  })

  it('excludes ineligible skills (missing OS)', () => {
    const skills: Record<string, Skill> = {
      weather: makeSkill('weather', {
        skillRequirements: { os: ['nonexistent_os'] },
      }),
    }
    const result = budgetSkillsForPrompt(skills, ['weather'])
    assert.equal(result[0].eligible, false)
    assert.equal(result[0].included, false)
  })

  it('respects MAX_SKILLS_IN_PROMPT count limit', () => {
    const skills: Record<string, Skill> = {}
    const ids: string[] = []
    for (let i = 0; i < MAX_SKILLS_IN_PROMPT + 10; i++) {
      const id = `skill-${String(i).padStart(4, '0')}`
      skills[id] = makeSkill(id, { content: 'x' })
      ids.push(id)
    }
    const result = budgetSkillsForPrompt(skills, ids)
    const included = result.filter((r) => r.included)
    assert.equal(included.length, MAX_SKILLS_IN_PROMPT)
    const excluded = result.filter((r) => !r.included && r.reason === 'skill count limit reached')
    assert.equal(excluded.length, 10)
  })

  it('respects MAX_SKILLS_PROMPT_CHARS budget', () => {
    // Create skills with large content that will exceed the budget
    const bigContent = 'x'.repeat(10_000)
    const skills: Record<string, Skill> = {
      a: makeSkill('a', { content: bigContent }),
      b: makeSkill('b', { content: bigContent }),
      c: makeSkill('c', { content: bigContent }),
      d: makeSkill('d', { content: bigContent }),
    }
    const result = budgetSkillsForPrompt(skills, ['a', 'b', 'c', 'd'])
    const included = result.filter((r) => r.included)
    // 10K * 3 = 30K, so at most 3 can fit
    assert.ok(included.length <= 3)
    const excluded = result.filter((r) => r.reason === 'character budget exceeded')
    assert.ok(excluded.length >= 1)
  })

  it('prioritizes always-on skills over regular skills', () => {
    const skills: Record<string, Skill> = {
      regular: makeSkill('regular'),
      alwaysOn: makeSkill('alwaysOn', { always: true }),
    }
    const result = budgetSkillsForPrompt(skills, [])
    const included = result.filter((r) => r.included)
    // always-on should come before regular
    const alwaysIdx = included.findIndex((r) => r.skill.name === 'alwaysOn')
    const regularIdx = included.findIndex((r) => r.skill.name === 'regular')
    assert.ok(alwaysIdx < regularIdx, 'always-on skill should be prioritized')
  })
})

describe('buildSkillPromptText', () => {
  it('builds formatted prompt text', () => {
    const skills: Record<string, Skill> = {
      weather: makeSkill('weather', { content: 'Use wttr.in for weather queries.' }),
    }
    const text = buildSkillPromptText(skills, ['weather'])
    assert.ok(text.includes('### weather'))
    assert.ok(text.includes('Use wttr.in for weather queries.'))
  })

  it('returns empty string for no matching skills', () => {
    const text = buildSkillPromptText({}, ['nonexistent'])
    assert.equal(text, '')
  })
})
