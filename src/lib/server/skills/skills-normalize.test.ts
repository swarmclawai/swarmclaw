import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSkillPayload } from '@/lib/server/skills/skills-normalize'

test('normalizeSkillPayload parses openclaw frontmatter metadata', () => {
  const normalized = normalizeSkillPayload({
    content: `---
name: github-sync
description: Sync GitHub issues into tasks.
version: 1.2.3
metadata:
  openclaw:
    requires:
      env:
        - GITHUB_TOKEN
      bins:
        - curl
    primaryEnv: GITHUB_TOKEN
    toolNames: [github_workspace, github-cli]
    capabilities: [github, pull-requests]
    homepage: https://example.com/github-sync
    install:
      - kind: brew
        formula: gh
        bins: [gh]
---
# Sync issues

Use the GitHub API.`,
  })

  assert.equal(normalized.name, 'github-sync')
  assert.equal(normalized.description, 'Sync GitHub issues into tasks.')
  assert.equal(normalized.version, '1.2.3')
  assert.equal(normalized.primaryEnv, 'GITHUB_TOKEN')
  assert.equal(normalized.homepage, 'https://example.com/github-sync')
  assert.deepEqual(normalized.toolNames, ['github_workspace', 'github-cli'])
  assert.deepEqual(normalized.capabilities, ['github', 'pull-requests'])
  assert.equal(normalized.sourceFormat, 'openclaw')
  assert.match(normalized.content, /# Sync issues/)
  assert.equal(normalized.skillRequirements?.env?.[0], 'GITHUB_TOKEN')
  assert.equal(normalized.installOptions?.[0]?.kind, 'brew')
  assert.equal(normalized.installOptions?.[0]?.bins?.[0], 'gh')
})

test('normalizeSkillPayload flags undeclared env vars in skill content', () => {
  const normalized = normalizeSkillPayload({
    content: `---
name: env-check
description: Reads process env.
---
Run with \`process.env.GITHUB_TOKEN\` and \`process.env.OPENAI_API_KEY\`.`,
  })

  assert.equal(normalized.security?.level, 'high')
  assert.ok(normalized.security?.missingDeclarations?.includes('GITHUB_TOKEN'))
  assert.ok(normalized.security?.missingDeclarations?.includes('OPENAI_API_KEY'))
})

test('normalizeSkillPayload parses executable invocation metadata from frontmatter', () => {
  const normalized = normalizeSkillPayload({
    content: `---
name: task-triage
description: Route task triage through manage_tasks.
invocation:
  userInvocable: false
command-dispatch: tool
command-tool: manage_tasks
command-arg-mode: raw
---
# Task Triage

Route the request through manage_tasks.`,
  })

  assert.deepEqual(normalized.invocation, { userInvocable: false })
  assert.deepEqual(normalized.commandDispatch, {
    kind: 'tool',
    toolName: 'manage_tasks',
    argMode: 'raw',
  })
})
