import assert from 'node:assert/strict'
import test from 'node:test'
import type { Skill } from '@/types'
import { buildDiscoveredSkillPromptText, collectPluginMatchedDiscoveredSkills } from './discovered-skill-prompt'
import type { DiscoveredSkill } from './skill-discovery'

function makeDiscoveredSkill(name: string, content = '# Skill body'): DiscoveredSkill {
  return {
    name,
    filename: `${name}.md`,
    description: `${name} description`,
    content,
    source: 'bundled',
    sourcePath: `/tmp/${name}/SKILL.md`,
    sourceFormat: 'plain',
    security: null,
    frontmatter: null,
  }
}

test('collectPluginMatchedDiscoveredSkills matches plugin aliases and keeps unrelated skills separate', () => {
  const googleSkill = makeDiscoveredSkill('google-workspace')
  const otherSkill = makeDiscoveredSkill('github-sync')

  const result = collectPluginMatchedDiscoveredSkills(
    [googleSkill, otherSkill],
    ['gws'],
    {},
  )

  assert.deepEqual(result.matched.map((skill) => skill.name), ['google-workspace'])
  assert.deepEqual(result.remaining.map((skill) => skill.name), ['github-sync'])
})

test('collectPluginMatchedDiscoveredSkills skips discovered skills already installed in storage', () => {
  const googleSkill = makeDiscoveredSkill('google-workspace')
  const storedSkills = {
    stored_google_workspace: {
      id: 'stored_google_workspace',
      name: 'Google Workspace',
    } as Skill,
  }

  const result = collectPluginMatchedDiscoveredSkills(
    [googleSkill],
    ['google_workspace'],
    storedSkills,
  )

  assert.equal(result.matched.length, 0)
  assert.deepEqual(result.remaining.map((skill) => skill.name), ['google-workspace'])
})

test('buildDiscoveredSkillPromptText renders plugin skill content', () => {
  const prompt = buildDiscoveredSkillPromptText([
    makeDiscoveredSkill('google-workspace', '# Google Workspace\nUse `gws`.'),
  ])

  assert.match(prompt, /## Plugin Skills/)
  assert.match(prompt, /### google-workspace/)
  assert.match(prompt, /Use `gws`\./)
})
