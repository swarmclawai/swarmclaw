import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'

import type { Agent, LearnedSkill, RunReflection, Session } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let workspaceDir = ''
let observeLearnedSkillRunOutcome: Awaited<typeof import('./learned-skills')>['observeLearnedSkillRunOutcome']
let listLearnedSkills: Awaited<typeof import('./learned-skills')>['listLearnedSkills']
let loadLearnedSkills: Awaited<typeof import('../storage')>['loadLearnedSkills']
let saveLearnedSkills: Awaited<typeof import('../storage')>['saveLearnedSkills']
let saveSessions: Awaited<typeof import('../storage')>['saveSessions']
let saveAgents: Awaited<typeof import('../storage')>['saveAgents']
let saveRunReflections: Awaited<typeof import('../storage')>['saveRunReflections']
let loadRunReflections: Awaited<typeof import('../storage')>['loadRunReflections']

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-learned-skills-'))
  workspaceDir = path.join(tempDir, 'workspace')
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = workspaceDir
  process.env.SWARMCLAW_BUILD_MODE = '1'
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
  fs.mkdirSync(workspaceDir, { recursive: true })

  const mod = await import('./learned-skills')
  observeLearnedSkillRunOutcome = mod.observeLearnedSkillRunOutcome
  listLearnedSkills = mod.listLearnedSkills

  const storage = await import('../storage')
  loadLearnedSkills = storage.loadLearnedSkills
  saveLearnedSkills = storage.saveLearnedSkills
  saveSessions = storage.saveSessions
  saveAgents = storage.saveAgents
  saveRunReflections = storage.saveRunReflections
  loadRunReflections = storage.loadRunReflections
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

function saveAgent(agentId = 'agent-learned') {
  saveAgents({
    [agentId]: {
      id: agentId,
      name: 'Learned Agent',
      description: 'Learns from repeated workflows.',
      systemPrompt: 'Stay helpful.',
      provider: 'openai',
      model: 'gpt-test',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies Agent,
  })
}

function resetLearnedSkillState() {
  saveLearnedSkills({})
  saveRunReflections({})
  saveAgents({})
  saveSessions({})
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-learned',
    name: 'Learned Session',
    cwd: workspaceDir,
    user: 'tester',
    provider: 'openai',
    model: 'gpt-test',
    claudeSessionId: null,
    messages: [
      { role: 'user', text: 'Please investigate the deploy workflow and keep the repair order stable.', time: 1 },
      { role: 'assistant', text: 'I validated config, reviewed logs, and reran smoke checks.', time: 2, toolEvents: [{ name: 'shell', input: 'npm test', output: 'ok' }] },
      { role: 'user', text: 'Do the same workflow again if this recurs.', time: 3 },
      { role: 'assistant', text: 'I used the same deploy repair workflow again.', time: 4, toolEvents: [{ name: 'files', input: 'cat deploy.log', output: 'ok' }] },
    ],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    sessionType: 'human',
    agentId: 'agent-learned',
    ...overrides,
  }
}

function makeReflection(id = 'reflection-1'): RunReflection {
  return {
    id,
    runId: 'run-reflection',
    sessionId: 'session-learned',
    agentId: 'agent-learned',
    source: 'chat',
    status: 'completed',
    summary: 'Reflection',
    invariantNotes: [],
    derivedNotes: [],
    failureNotes: ['Repeated failures should become stable repair guidance.'],
    lessonNotes: ['Prefer the proven repair order.'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

test('repeated successful workflows activate an agent-scoped learned skill and patch reflection notes', async () => {
  resetLearnedSkillState()
  saveAgent()
  saveSessions({ 'session-learned': makeSession() })
  saveRunReflections({ 'reflection-1': makeReflection() })

  const generateText = async () => JSON.stringify({
    workflowKey: 'success:shell_files_deploy_workflow',
    objectiveSummary: 'Repeat the deploy repair workflow with the same order.',
    name: 'deploy-repair-workflow',
    description: 'Repair deploy regressions in a stable order.',
    content: 'Validate config, inspect logs, confirm env state, and rerun smoke checks in that order.',
    tags: ['deploy', 'repair'],
    rationale: 'This workflow repeated successfully and should stay consistent.',
    confidence: 0.88,
    riskLevel: 'low',
  })

  const first = await observeLearnedSkillRunOutcome({
    runId: 'run-1',
    sessionId: 'session-learned',
    agentId: 'agent-learned',
    source: 'chat',
    status: 'completed',
    resultText: 'Repeated the deploy repair workflow successfully.',
    toolEvents: [
      { name: 'shell', input: 'npm test', output: 'ok' },
      { name: 'files', input: 'cat deploy.log', output: 'ok' },
    ],
    reflection: loadRunReflections()['reflection-1'],
  }, { generateText })

  const second = await observeLearnedSkillRunOutcome({
    runId: 'run-2',
    sessionId: 'session-learned',
    agentId: 'agent-learned',
    source: 'chat',
    status: 'completed',
    resultText: 'Repeated the deploy repair workflow successfully again.',
    toolEvents: [
      { name: 'shell', input: 'npm test', output: 'ok' },
      { name: 'files', input: 'cat deploy.log', output: 'ok' },
    ],
    reflection: loadRunReflections()['reflection-1'],
  }, { generateText })

  const learned = listLearnedSkills({ agentId: 'agent-learned' })
  const active = learned.find((skill) => skill.lifecycle === 'active')

  assert.ok(first.notes.length > 0)
  assert.ok(second.notes.length > 0)
  assert.ok(active, 'expected an active learned skill after repeated success')
  assert.equal(active?.scope, 'agent')
  assert.equal(active?.sourceKind, 'success_pattern')
  assert.equal(active?.name, 'deploy-repair-workflow')
  assert.equal(active?.validationStatus, 'passed')
  assert.ok((active?.evidenceCount || 0) >= 2)
  assert.ok((loadRunReflections()['reflection-1']?.learnedSkillNotes || []).length > 0)
})

test('repeated external failures activate a failure-repair learned skill', async () => {
  resetLearnedSkillState()
  saveAgent('agent-failure')
  saveSessions({
    'session-failure': makeSession({
      id: 'session-failure',
      agentId: 'agent-failure',
      name: 'Failure Session',
      messages: [
        { role: 'user', text: 'Send this voice note to WhatsApp even if the normal route is broken.', time: 1 },
        { role: 'assistant', text: 'The WhatsApp voice note path failed.', time: 2, toolEvents: [{ name: 'whatsapp', input: 'send voice', output: 'failed', error: true }] },
      ],
    }),
  })

  const generateText = async () => JSON.stringify({
    workflowKey: 'external_whatsapp_voice_delivery',
    objectiveSummary: 'Repair WhatsApp voice delivery using the fallback voice path.',
    name: 'whatsapp-voice-fallback',
    description: 'Use a fallback voice synthesis path for WhatsApp delivery.',
    content: 'If WhatsApp voice delivery fails, regenerate audio through the approved voice provider and resend via the fallback delivery path.',
    tags: ['whatsapp', 'voice', 'fallback'],
    rationale: 'This repeated failure needs a stable compensating workflow.',
    confidence: 0.93,
    riskLevel: 'low',
  })

  await observeLearnedSkillRunOutcome({
    runId: 'run-f1',
    sessionId: 'session-failure',
    agentId: 'agent-failure',
    source: 'chat',
    status: 'failed',
    error: 'WhatsApp voice note delivery failed after ElevenLabs audio generation.',
    toolEvents: [
      { name: 'whatsapp', input: 'send voice', output: 'failed', error: true },
    ],
  }, { generateText })

  await observeLearnedSkillRunOutcome({
    runId: 'run-f2',
    sessionId: 'session-failure',
    agentId: 'agent-failure',
    source: 'chat',
    status: 'failed',
    error: 'WhatsApp voice note delivery failed after ElevenLabs audio generation.',
    toolEvents: [
      { name: 'whatsapp', input: 'send voice', output: 'failed', error: true },
    ],
  }, { generateText })

  const active = listLearnedSkills({ agentId: 'agent-failure' })
    .find((skill) => skill.lifecycle === 'active')

  assert.ok(active)
  assert.equal(active?.sourceKind, 'failure_repair')
  assert.equal(active?.failureFamily, 'external_whatsapp_voice_delivery')
  assert.equal(active?.name, 'whatsapp-voice-fallback')
})

test('selected learned skills auto-demote after repeated failures', async () => {
  resetLearnedSkillState()
  const now = Date.now()
  saveAgent('agent-demote')
  const learnedSkill: LearnedSkill = {
    id: 'learned-active',
    agentId: 'agent-demote',
    userId: 'tester',
    sessionId: 'session-demote',
    scope: 'agent',
    lifecycle: 'active',
    sourceKind: 'failure_repair',
    workflowKey: 'external_whatsapp_voice_delivery',
    failureFamily: 'external_whatsapp_voice_delivery',
    objectiveSummary: 'Repair WhatsApp voice delivery.',
    name: 'whatsapp-voice-fallback',
    description: 'Fallback for voice delivery.',
    content: '# whatsapp-voice-fallback\n\nUse the fallback delivery path.',
    validationStatus: 'passed',
    validationSummary: 'ready',
    evidenceCount: 2,
    activationCount: 1,
    successCount: 0,
    failureCount: 0,
    consecutiveSuccessCount: 0,
    consecutiveFailureCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  saveLearnedSkills({ [learnedSkill.id]: learnedSkill })
  saveSessions({
    'session-demote': makeSession({
      id: 'session-demote',
      agentId: 'agent-demote',
      messages: [
        { role: 'user', text: 'Send the WhatsApp voice note.', time: 1 },
        { role: 'assistant', text: 'Trying the learned fallback.', time: 2 },
      ],
      skillRuntimeState: {
        selectedSkillId: 'learned-active',
        selectedSkillName: 'whatsapp-voice-fallback',
        selectedAt: now,
        lastAction: 'select',
      },
    }),
  })

  await observeLearnedSkillRunOutcome({
    runId: 'run-d1',
    sessionId: 'session-demote',
    agentId: 'agent-demote',
    source: 'chat',
    status: 'failed',
    error: 'WhatsApp voice note delivery still failed after fallback.',
    toolEvents: [{ name: 'whatsapp', input: 'send voice', output: 'failed', error: true }],
  }, {
    generateText: async () => JSON.stringify({
      workflowKey: 'external_whatsapp_voice_delivery',
      objectiveSummary: 'Repair WhatsApp voice delivery.',
      name: 'whatsapp-voice-fallback-v2',
      description: 'Revised fallback.',
      content: 'Try a revised resend workflow.',
      tags: ['whatsapp'],
      rationale: 'Needs revision.',
      confidence: 0.6,
      riskLevel: 'low',
    }),
  })

  await observeLearnedSkillRunOutcome({
    runId: 'run-d2',
    sessionId: 'session-demote',
    agentId: 'agent-demote',
    source: 'chat',
    status: 'failed',
    error: 'WhatsApp voice note delivery still failed after fallback.',
    toolEvents: [{ name: 'whatsapp', input: 'send voice', output: 'failed', error: true }],
  }, {
    generateText: async () => JSON.stringify({
      workflowKey: 'external_whatsapp_voice_delivery',
      objectiveSummary: 'Repair WhatsApp voice delivery.',
      name: 'whatsapp-voice-fallback-v2',
      description: 'Revised fallback.',
      content: 'Try a revised resend workflow.',
      tags: ['whatsapp'],
      rationale: 'Needs revision.',
      confidence: 0.6,
      riskLevel: 'low',
    }),
  })

  const updated = loadLearnedSkills()['learned-active']
  assert.equal(updated.lifecycle, 'demoted')
  assert.ok(updated.demotedAt)
  assert.match(String(updated.demotionReason || ''), /failed/i)
})
