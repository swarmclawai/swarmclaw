import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Skill } from '@/types'
import {
  buildRuntimeSkillPromptBlocks,
  recommendRuntimeSkillsForTask,
  resolveRuntimeSkills,
} from './runtime-skill-resolver'

function makeSkill(id: string, overrides: Partial<Skill> = {}): Skill {
  return {
    id,
    name: id,
    filename: `${id}.md`,
    content: `# ${id}\nUse ${id}.`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

test('resolveRuntimeSkills prefers project-local skills over stored skills with the same key', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-skill-resolver-'))
  try {
    const skillDir = path.join(cwd, 'skills', 'github-sync')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: github-sync
description: Project-local GitHub flow.
metadata:
  openclaw:
    toolNames: [shell]
---
# Project Skill

Prefer the project workflow.
`)

    const storedSkills = {
      stored_github_sync: makeSkill('stored_github_sync', {
        name: 'github-sync',
        description: 'Stored GitHub flow.',
        content: '# Stored Skill\nUse the stored workflow.',
        toolNames: ['http_request'],
      }),
    }

    const snapshot = resolveRuntimeSkills({
      cwd,
      enabledPlugins: ['shell'],
      storedSkills,
      agentSkillIds: ['stored_github_sync'],
    })
    const githubSkill = snapshot.skills.find((skill) => skill.key === 'github_sync')

    assert.ok(githubSkill)
    assert.equal(githubSkill?.source, 'project')
    assert.equal(githubSkill?.attached, true, 'attachment survives precedence merge')
    assert.match(githubSkill?.content || '', /Project Skill/)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('resolveRuntimeSkills auto-matches skills from explicit tool metadata and reports missing config', () => {
  const storedSkills = {
    weather_skill: makeSkill('weather_skill', {
      name: 'weather-helper',
      toolNames: ['google_workspace', 'gws'],
      capabilities: ['weather', 'forecast'],
      skillRequirements: { config: ['nonexistent.skill.path'] },
    }),
  }

  const snapshot = resolveRuntimeSkills({
    enabledPlugins: ['google_workspace'],
    storedSkills,
  })
  const skill = snapshot.skills.find((entry) => entry.name === 'weather-helper')

  assert.equal(skill?.autoMatch, true)
  assert.equal(skill?.eligible, false)
  assert.deepEqual(skill?.missing, ['config nonexistent.skill.path'])
  assert.ok(skill?.matchReasons.some((reason) => /matches tools/i.test(reason)))
})

test('recommendRuntimeSkillsForTask ranks matching local skills and prompt blocks include auto-matched skills', () => {
  const storedSkills = {
    gws_skill: makeSkill('gws_skill', {
      name: 'google-workspace-helper',
      description: 'Automate Google Workspace docs and sheets.',
      toolNames: ['google_workspace', 'gws'],
      capabilities: ['docs', 'sheets', 'workspace'],
    }),
    generic_skill: makeSkill('generic_skill', {
      name: 'generic-notes',
      description: 'Store notes.',
    }),
  }

  const snapshot = resolveRuntimeSkills({
    enabledPlugins: ['google_workspace'],
    storedSkills,
  })
  const recommended = recommendRuntimeSkillsForTask(snapshot.skills, 'Update the Google Docs and Sheets workspace report', ['google_workspace'])

  assert.equal(recommended[0]?.skill.name, 'google-workspace-helper')
  const blocks = buildRuntimeSkillPromptBlocks(snapshot).join('\n')
  assert.match(blocks, /Skill Runtime/)
  assert.match(blocks, /Available Skills/)
  assert.match(blocks, /google-workspace-helper/)
})

test('buildRuntimeSkillPromptBlocks only inlines pinned skills before explicit selection', () => {
  const storedSkills = {
    pinned_skill: makeSkill('pinned_skill', {
      name: 'Pinned Workflow',
    }),
    generic_skill: makeSkill('generic_skill', {
      name: 'Generic Helper',
      description: 'Useful fallback workflow.',
    }),
  }

  const snapshot = resolveRuntimeSkills({
    storedSkills,
    agentSkillIds: ['pinned_skill'],
  })
  const blocks = buildRuntimeSkillPromptBlocks(snapshot).join('\n')

  assert.match(blocks, /Pinned Skills/)
  assert.match(blocks, /discoverable by default/i)
  assert.match(blocks, /Pinned Workflow/)
  assert.match(blocks, /Generic Helper/)
  assert.doesNotMatch(blocks, /### Generic Helper/)
})

test('resolveRuntimeSkills marks the selected skill and loads it into the prompt separately', () => {
  const storedSkills = {
    pinned_skill: makeSkill('pinned_skill', {
      name: 'Pinned Workflow',
    }),
    selected_skill: makeSkill('selected_skill', {
      name: 'Selected Workflow',
    }),
  }

  const snapshot = resolveRuntimeSkills({
    storedSkills,
    agentSkillIds: ['pinned_skill'],
    selectedSkillId: 'selected_skill',
  })
  const blocks = buildRuntimeSkillPromptBlocks(snapshot).join('\n')

  assert.equal(snapshot.selectedSkill?.name, 'Selected Workflow')
  assert.match(blocks, /Active Selected Skill/)
  assert.match(blocks, /Selected Workflow/)
  assert.match(blocks, /### Selected Workflow/)
})
