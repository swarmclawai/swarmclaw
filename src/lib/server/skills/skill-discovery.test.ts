import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { discoverSkills } from './skill-discovery'

test('discoverSkills includes tracked bundled skills from bundled-skills', () => {
  const skills = discoverSkills({ cwd: path.join(process.cwd(), 'src') })
  const googleWorkspaceSkill = skills.find((skill) => skill.name === 'google-workspace')

  assert.ok(googleWorkspaceSkill)
  assert.equal(googleWorkspaceSkill?.source, 'bundled')
  assert.equal(
    googleWorkspaceSkill?.sourcePath.endsWith(path.join('bundled-skills', 'google-workspace', 'SKILL.md')),
    true,
  )
})
