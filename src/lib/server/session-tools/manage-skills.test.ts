import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Agent, Skill } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let workspaceDir = ''
let buildCrudTools: Awaited<typeof import('./crud')>['buildCrudTools']
let loadSkills: Awaited<typeof import('../storage')>['loadSkills']
let loadAgent: Awaited<typeof import('../storage')>['loadAgent']
let saveAgents: Awaited<typeof import('../storage')>['saveAgents']
let saveSessions: Awaited<typeof import('../storage')>['saveSessions']
let upsertApproval: Awaited<typeof import('../storage')>['upsertApproval']

function buildManageSkillsTool() {
  const tools = buildCrudTools({
    cwd: workspaceDir,
    ctx: { sessionId: 'skill-session', agentId: 'agent-skill-test', platformAssignScope: 'self' },
    hasPlugin: (name) => name === 'manage_skills',
    hasTool: (name) => name === 'manage_skills',
    cleanupFns: [],
    commandTimeoutMs: 1_000,
    claudeTimeoutMs: 1_000,
    cliProcessTimeoutMs: 1_000,
    persistDelegateResumeId: () => {},
    readStoredDelegateResumeId: () => null,
    resolveCurrentSession: () => null,
    activePlugins: ['manage_skills', 'google_workspace'],
  })
  const tool = tools.find((entry) => entry.name === 'manage_skills')
  assert.ok(tool, 'expected manage_skills tool')
  return tool!
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-manage-skills-'))
  workspaceDir = path.join(tempDir, 'workspace')
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = workspaceDir
  process.env.SWARMCLAW_BUILD_MODE = '1'
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
  fs.mkdirSync(workspaceDir, { recursive: true })

  const crudMod = await import('./crud')
  buildCrudTools = crudMod.buildCrudTools

  const storageMod = await import('../storage')
  loadSkills = storageMod.loadSkills
  loadAgent = storageMod.loadAgent
  saveAgents = storageMod.saveAgents
  saveSessions = storageMod.saveSessions
  upsertApproval = storageMod.upsertApproval

  saveAgents({
    'agent-skill-test': {
      id: 'agent-skill-test',
      name: 'Skill Tester',
      provider: 'openai',
      model: 'gpt-test',
      plugins: ['manage_skills'],
      tools: ['manage_skills'],
      skillIds: [],
      platformAssignScope: 'self',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies Agent,
  })
  saveSessions({
    'skill-session': {
      id: 'skill-session',
      name: 'Skill Session',
      cwd: workspaceDir,
      user: 'tester',
      provider: 'openai',
      model: 'gpt-test',
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      sessionType: 'human',
      agentId: 'agent-skill-test',
      plugins: ['manage_skills'],
      heartbeatEnabled: false,
    },
  })
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

describe('manage_skills runtime actions', () => {
  it('status reports resolved local skills with eligibility and metadata', async () => {
    const manageSkills = buildManageSkillsTool()
    const created = await manageSkills.invoke({
      action: 'create',
      name: 'workspace-helper',
      description: 'Automate workspace docs.',
      content: '# Workspace Helper\nUse the workspace workflow.',
      toolNames: ['google_workspace'],
      capabilities: ['docs', 'workspace'],
    })
    const createdSkill = JSON.parse(String(created)) as Skill

    const raw = await manageSkills.invoke({ action: 'status', query: 'workspace docs' })
    const result = JSON.parse(String(raw)) as Array<Record<string, unknown>>

    const statusEntry = result.find((entry) => entry.storageId === createdSkill.id)
    assert.ok(statusEntry)
    assert.equal(statusEntry?.eligible, true)
    assert.deepEqual(statusEntry?.toolNames, ['google_workspace'])
  })

  it('attach materializes a discovered project skill and binds it to the current agent', async () => {
    const localSkillDir = path.join(workspaceDir, 'skills', 'project-helper')
    fs.mkdirSync(localSkillDir, { recursive: true })
    fs.writeFileSync(path.join(localSkillDir, 'SKILL.md'), `---
name: project-helper
description: Project-local helper.
metadata:
  openclaw:
    toolNames: [google_workspace]
---
# Project Helper

Use the project helper.
`)

    const manageSkills = buildManageSkillsTool()
    const raw = await manageSkills.invoke({
      action: 'attach',
      name: 'project-helper',
    })
    const result = JSON.parse(String(raw)) as Record<string, unknown>
    const skillId = String(result.skillId || '')
    const agent = loadAgent('agent-skill-test') as Agent

    assert.ok(skillId)
    assert.ok(loadSkills()[skillId], 'discovered skill copied into managed storage')
    assert.ok(agent.skillIds?.includes(skillId), 'skill attached to current agent')
  })

  it('install is approval-gated and can install a remote skill after approval', async () => {
    const manageSkills = buildManageSkillsTool()
    const firstRaw = await manageSkills.invoke({
      action: 'install',
      name: 'remote-helper',
      url: 'https://clawhub.ai/skills/remote-helper',
      content: '# Remote Helper\nUse the remote helper.',
      attach: true,
    })
    const first = JSON.parse(String(firstRaw)) as Record<string, unknown>
    const approval = first.approval as { id: string }

    assert.equal(first.requiresApproval, true)
    assert.ok(approval?.id)

    upsertApproval(approval.id, {
      ...(first.approval as Record<string, unknown>),
      status: 'approved',
      updatedAt: Date.now(),
    })

    const secondRaw = await manageSkills.invoke({
      action: 'install',
      name: 'remote-helper',
      url: 'https://clawhub.ai/skills/remote-helper',
      content: '# Remote Helper\nUse the remote helper.',
      attach: true,
      approvalId: approval.id,
    })
    const second = JSON.parse(String(secondRaw)) as Record<string, unknown>
    const installedSkill = second.skill as Skill
    const agent = loadAgent('agent-skill-test') as Agent

    assert.equal(second.ok, true)
    assert.ok(installedSkill?.id)
    assert.ok(loadSkills()[installedSkill.id])
    assert.ok(agent.skillIds?.includes(installedSkill.id), 'approved install can attach to the agent')
  })
})
