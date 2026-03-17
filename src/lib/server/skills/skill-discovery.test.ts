import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { clearDiscoveredSkillsCache, discoverSkills } from './skill-discovery'

test('discoverSkills includes tracked bundled skills from skills', () => {
  const skills = discoverSkills({ cwd: path.join(process.cwd(), 'src') })
  const googleWorkspaceSkill = skills.find((skill) => skill.name === 'google-workspace')

  assert.ok(googleWorkspaceSkill)
  assert.equal(googleWorkspaceSkill?.source, 'bundled')
  assert.equal(
    googleWorkspaceSkill?.sourcePath.endsWith(path.join('skills', 'google-workspace', 'SKILL.md')),
    true,
  )
})

test('discoverSkills reads workspace skills from SWARMCLAW_HOME when set', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-skills-home-'))
  const skillDir = path.join(tempHome, 'skills', 'local-skill')
  const previousHome = process.env.SWARMCLAW_HOME

  try {
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: local-skill
description: A local test skill.
---

# Local Skill
`, 'utf8')
    process.env.SWARMCLAW_HOME = tempHome
    clearDiscoveredSkillsCache()

    const skills = discoverSkills()
    const localSkill = skills.find((skill) => skill.name === 'local-skill')

    assert.ok(localSkill)
    assert.equal(localSkill?.source, 'workspace')
    assert.equal(localSkill?.sourcePath, path.join(skillDir, 'SKILL.md'))
  } finally {
    clearDiscoveredSkillsCache()
    if (previousHome === undefined) delete process.env.SWARMCLAW_HOME
    else process.env.SWARMCLAW_HOME = previousHome
    fs.rmSync(tempHome, { recursive: true, force: true })
  }
})
