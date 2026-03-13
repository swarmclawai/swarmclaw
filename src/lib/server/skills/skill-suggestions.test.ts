import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'

import type { Session, SkillSuggestion } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let workspaceDir = ''
let createSkillSuggestionFromSession: Awaited<typeof import('./skill-suggestions')>['createSkillSuggestionFromSession']
let buildSessionTranscript: Awaited<typeof import('./skill-suggestions')>['buildSessionTranscript']
let materializeSkillSuggestion: Awaited<typeof import('./skill-suggestions')>['materializeSkillSuggestion']
let parseSkillSuggestionResponse: Awaited<typeof import('./skill-suggestions')>['parseSkillSuggestionResponse']
let loadSkillSuggestions: Awaited<typeof import('../storage')>['loadSkillSuggestions']
let saveSkillSuggestions: Awaited<typeof import('../storage')>['saveSkillSuggestions']
let loadSkills: Awaited<typeof import('../storage')>['loadSkills']
let saveSkills: Awaited<typeof import('../storage')>['saveSkills']
let saveSessions: Awaited<typeof import('../storage')>['saveSessions']

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-skill-suggestions-'))
  workspaceDir = path.join(tempDir, 'workspace')
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = workspaceDir
  process.env.SWARMCLAW_BUILD_MODE = '1'
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
  fs.mkdirSync(workspaceDir, { recursive: true })

  const mod = await import('./skill-suggestions')
  createSkillSuggestionFromSession = mod.createSkillSuggestionFromSession
  buildSessionTranscript = mod.buildSessionTranscript
  materializeSkillSuggestion = mod.materializeSkillSuggestion
  parseSkillSuggestionResponse = mod.parseSkillSuggestionResponse

  const storage = await import('../storage')
  loadSkillSuggestions = storage.loadSkillSuggestions
  saveSkillSuggestions = storage.saveSkillSuggestions
  loadSkills = storage.loadSkills
  saveSkills = storage.saveSkills
  saveSessions = storage.saveSessions
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-skill',
    name: 'Skillable Session',
    cwd: workspaceDir,
    user: 'tester',
    provider: 'openai',
    model: 'gpt-test',
    claudeSessionId: null,
    messages: [
      { role: 'user', text: 'Please investigate why the deploy check keeps failing and capture the exact fix order.', time: 1 },
      { role: 'assistant', text: 'I traced it to missing env validation. I used shell and file tools, then verified the fix order.', time: 2, toolEvents: [{ name: 'shell', input: 'npm test', output: 'ok' }] },
    ],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    sessionType: 'human',
    ...overrides,
  }
}

test('buildSessionTranscript includes tool summaries for recent messages', () => {
  const transcript = buildSessionTranscript(makeSession())
  assert.match(transcript, /USER: Please investigate/i)
  assert.match(transcript, /ASSISTANT: I traced it/i)
  assert.match(transcript, /Tools: shell\(ok\)/i)
})

test('parseSkillSuggestionResponse accepts fenced JSON and normalizes markdown content', () => {
  const parsed = parseSkillSuggestionResponse(`\`\`\`json
{"name":"deploy-verification","description":"Check deploy blockers in order.","content":"Verify env validation before rerunning deploy.","tags":["deploy","verification"],"confidence":0.84,"rationale":"The conversation produced a repeatable troubleshooting sequence.","summary":"A deploy check failure was resolved by validating env config first."}
\`\`\``)
  assert.equal(parsed.skip, false)
  assert.equal(parsed.suggestion?.name, 'deploy-verification')
  assert.match(parsed.suggestion?.content || '', /^# deploy-verification/m)
  assert.deepEqual(parsed.suggestion?.tags, ['deploy', 'verification'])
})

test('createSkillSuggestionFromSession stores a draft suggestion from a session transcript', async () => {
  saveSessions({ 'session-skill': makeSession() })
  const suggestion = await createSkillSuggestionFromSession('session-skill', {
    generateText: async () => JSON.stringify({
      name: 'deploy-verification',
      description: 'Check deploy blockers in order.',
      content: 'Validate env configuration before rerunning deploy or smoke checks.',
      tags: ['deploy', 'verification'],
      confidence: 0.91,
      rationale: 'The transcript captured a reusable deployment-debugging flow.',
      summary: 'A deploy check failure was fixed by validating configuration before retrying.',
    }),
  })

  assert.equal(suggestion.status, 'draft')
  assert.equal(loadSkillSuggestions()[suggestion.id]?.name, 'deploy-verification')
  assert.match(String(suggestion.sourceSnippet || ''), /deploy check/i)
})

test('createSkillSuggestionFromSession refreshes the same draft for a session instead of creating duplicates', async () => {
  saveSessions({
    'session-skill': makeSession({
      messages: [
        { role: 'user', text: 'Please diagnose the deploy issue.', time: 1 },
        { role: 'assistant', text: 'I checked config order and smoke checks.', time: 2, toolEvents: [{ name: 'shell', input: 'npm test', output: 'ok' }] },
      ],
    }),
  })

  const first = await createSkillSuggestionFromSession('session-skill', {
    generateText: async () => JSON.stringify({
      name: 'deploy-triage',
      description: 'Triage deploy issues in a fixed order.',
      content: 'Validate config, then smoke checks.',
      tags: ['deploy'],
      confidence: 0.7,
      rationale: 'Reusable deploy triage flow.',
      summary: 'Initial deploy triage.',
    }),
  })

  saveSessions({
    'session-skill': makeSession({
      messages: [
        { role: 'user', text: 'Please diagnose the deploy issue.', time: 1 },
        { role: 'assistant', text: 'I checked config order and smoke checks.', time: 2, toolEvents: [{ name: 'shell', input: 'npm test', output: 'ok' }] },
        { role: 'user', text: 'Also include rollback verification.', time: 3 },
        { role: 'assistant', text: 'I added rollback validation and log review.', time: 4, toolEvents: [{ name: 'files', input: 'cat deploy.log', output: 'ok' }] },
      ],
    }),
  })

  const refreshed = await createSkillSuggestionFromSession('session-skill', {
    generateText: async () => JSON.stringify({
      name: 'deploy-triage',
      description: 'Triage deploy issues in a fixed order.',
      content: 'Validate config, review logs, verify rollback, then rerun smoke checks.',
      tags: ['deploy', 'rollback'],
      confidence: 0.85,
      rationale: 'Reusable deploy triage flow.',
      summary: 'Deploy triage now includes rollback validation.',
    }),
  })

  assert.equal(refreshed.id, first.id)
  assert.match(refreshed.content, /rollback/i)
  assert.equal(Object.keys(loadSkillSuggestions()).length >= 1, true)
})

test('materializeSkillSuggestion promotes an approved draft into a stored skill', () => {
  const now = Date.now()
  const draft: SkillSuggestion = {
    id: 'suggestion-1',
    status: 'draft',
    sourceSessionId: 'session-skill',
    sourceSessionName: 'Skillable Session',
    sourceAgentId: null,
    sourceAgentName: null,
    sourceHash: 'abc',
    name: 'incident-triage',
    description: 'Triage incidents in a stable order.',
    content: '# incident-triage\n\nCheck logs, config, then verification.',
    tags: ['incident', 'triage'],
    confidence: 0.76,
    rationale: 'It is a reusable troubleshooting checklist.',
    summary: 'The conversation resolved a broken deploy by following a fixed order.',
    sourceSnippet: 'USER: deploy is broken',
    createdSkillId: null,
    approvedAt: null,
    rejectedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  saveSkillSuggestions({ 'suggestion-1': draft })

  const result = materializeSkillSuggestion('suggestion-1')
  assert.equal(result.suggestion.status, 'approved')
  assert.ok(result.skill.id)
  assert.equal(loadSkills()[result.skill.id]?.name, 'incident-triage')
})

test('materializeSkillSuggestion links to an existing skill with the same name', () => {
  const now = Date.now()
  saveSkillSuggestions({
    'suggestion-existing': {
      id: 'suggestion-existing',
      status: 'draft',
      sourceSessionId: 'session-skill',
      sourceSessionName: 'Skillable Session',
      sourceAgentId: null,
      sourceAgentName: null,
      sourceHash: 'def',
      sourceMessageCount: 4,
      name: 'deploy-verification',
      description: 'Check deploy blockers in order.',
      content: '# deploy-verification\n\nValidate env config before rerunning smoke checks.',
      tags: ['deploy'],
      confidence: 0.8,
      rationale: 'Reusable deploy verification flow.',
      summary: 'Deploy verification flow.',
      sourceSnippet: 'USER: deploy is broken',
      createdSkillId: null,
      approvedAt: null,
      rejectedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  })
  const existingSkill: Skill = {
    id: 'skill-existing',
    name: 'deploy-verification',
    filename: 'deploy-verification.md',
    content: '# deploy-verification\n\nExisting skill.',
    createdAt: now,
    updatedAt: now,
  }
  const skills = loadSkills()
  skills[existingSkill.id] = existingSkill
  saveSkills(skills)

  const result = materializeSkillSuggestion('suggestion-existing')
  assert.equal(result.skill.id, existingSkill.id)
  assert.equal(result.suggestion.createdSkillId, existingSkill.id)
})
