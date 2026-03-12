import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildGitHubIssueTaskDescription,
  buildGitHubIssueTaskTags,
  buildGitHubIssueTaskTitle,
  parseGitHubRepoInput,
} from './helpers'

test('parseGitHubRepoInput accepts repo slugs and GitHub URLs', () => {
  assert.deepEqual(parseGitHubRepoInput('swarmclawai/swarmclaw'), {
    owner: 'swarmclawai',
    repo: 'swarmclaw',
    fullName: 'swarmclawai/swarmclaw',
  })

  assert.deepEqual(parseGitHubRepoInput('https://github.com/swarmclawai/swarmclaw/issues'), {
    owner: 'swarmclawai',
    repo: 'swarmclaw',
    fullName: 'swarmclawai/swarmclaw',
  })

  assert.equal(parseGitHubRepoInput('not-a-repo'), null)
  assert.equal(parseGitHubRepoInput('https://example.com/swarmclawai/swarmclaw'), null)
})

test('GitHub issue mapping builds a source-aware task payload shape', () => {
  const issue = {
    id: 12345,
    number: 87,
    title: 'Import GitHub issues into the board',
    body: 'Bring open issues into SwarmClaw tasks.',
    state: 'open',
    html_url: 'https://github.com/swarmclawai/swarmclaw/issues/87',
    labels: [{ name: 'feature' }, { name: 'task board' }, { name: 'feature' }],
    assignee: { login: 'waydelyle' },
    user: { login: 'octocat' },
  }

  assert.equal(
    buildGitHubIssueTaskTitle(issue, 'swarmclawai/swarmclaw'),
    '[swarmclawai/swarmclaw#87] Import GitHub issues into the board',
  )

  assert.equal(
    buildGitHubIssueTaskDescription(issue, 'swarmclawai/swarmclaw'),
    [
      'Imported from GitHub issue swarmclawai/swarmclaw#87',
      'URL: https://github.com/swarmclawai/swarmclaw/issues/87',
      'State: open',
      'Labels: feature, task board, feature',
      'Assignee: waydelyle',
      'Opened by: octocat',
      '',
      'Bring open issues into SwarmClaw tasks.',
    ].join('\n'),
  )

  assert.deepEqual(buildGitHubIssueTaskTags(issue, 'swarmclawai/swarmclaw'), [
    'github',
    'swarmclawai/swarmclaw',
    'feature',
    'task board',
  ])
})
