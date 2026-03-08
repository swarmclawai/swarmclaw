import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSkillSavePayload } from './skill-save-payload'

test('buildSkillSavePayload preserves imported skill metadata when saving', () => {
  const payload = buildSkillSavePayload({
    name: 'GitHub Sync',
    filename: 'github-sync.md',
    description: 'Sync GitHub issues into tasks.',
    content: '# Sync issues',
    scope: 'agent',
    agentIds: ['agent-1'],
  }, {
    sourceUrl: 'https://example.com/SKILL.md',
    sourceFormat: 'openclaw',
    author: 'Codex',
    tags: ['github', 'tasks'],
    version: '1.2.3',
    homepage: 'https://example.com/github-sync',
    primaryEnv: 'GITHUB_TOKEN',
    skillKey: 'github-sync',
    always: true,
    installOptions: [{ kind: 'brew', label: 'gh', bins: ['gh'] }],
    skillRequirements: { env: ['GITHUB_TOKEN'] },
    detectedEnvVars: ['GITHUB_TOKEN'],
    security: { level: 'medium', notes: ['Review install steps.'] },
    frontmatter: { name: 'github-sync', metadata: { openclaw: { primaryEnv: 'GITHUB_TOKEN' } } },
  })

  assert.equal(payload.sourceFormat, 'openclaw')
  assert.equal(payload.version, '1.2.3')
  assert.equal(payload.primaryEnv, 'GITHUB_TOKEN')
  assert.equal(payload.skillKey, 'github-sync')
  assert.deepEqual(payload.agentIds, ['agent-1'])
  assert.deepEqual(payload.skillRequirements, { env: ['GITHUB_TOKEN'] })
  assert.deepEqual(payload.security, { level: 'medium', notes: ['Review install steps.'] })
  assert.deepEqual(payload.frontmatter, { name: 'github-sync', metadata: { openclaw: { primaryEnv: 'GITHUB_TOKEN' } } })
})
