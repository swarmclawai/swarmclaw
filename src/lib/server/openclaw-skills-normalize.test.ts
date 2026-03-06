import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeOpenClawSkillsPayload } from './openclaw-skills-normalize'

test('normalizeOpenClawSkillsPayload maps gateway skill reports into UI entries', () => {
  const normalized = normalizeOpenClawSkillsPayload({
    workspaceDir: '/tmp/workspace',
    skills: [
      {
        name: 'github',
        description: 'GitHub operations',
        source: 'openclaw-bundled',
        eligible: true,
        requirements: {
          bins: ['gh'],
          anyBins: [['git', 'jj']],
          env: ['GH_TOKEN'],
        },
        missing: {
          config: ['channels.github'],
        },
        install: [
          { kind: 'brew', label: 'Install GitHub CLI', bins: ['gh'] },
        ],
        configChecks: [
          { path: 'channels.github', satisfied: false },
        ],
        skillKey: 'github',
        baseDir: '/tmp/github',
      },
    ],
  })

  assert.equal(normalized.length, 1)
  assert.deepEqual(normalized[0], {
    name: 'github',
    description: 'GitHub operations',
    source: 'bundled',
    eligible: true,
    missing: ['config channels.github'],
    disabled: false,
    installOptions: [
      { kind: 'brew', label: 'Install GitHub CLI', bins: ['gh'] },
    ],
    skillRequirements: {
      bins: ['gh'],
      anyBins: [['git', 'jj']],
      env: ['GH_TOKEN'],
      config: undefined,
      os: undefined,
    },
    configChecks: [{ key: 'channels.github', ok: false }],
    skillKey: 'github',
    baseDir: '/tmp/github',
  })
})
