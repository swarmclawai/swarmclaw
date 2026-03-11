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
let buildSessionTools: Awaited<typeof import('./index')>['buildSessionTools']
let saveAgents: Awaited<typeof import('../storage')>['saveAgents']
let saveSessions: Awaited<typeof import('../storage')>['saveSessions']
let saveSkills: Awaited<typeof import('../storage')>['saveSkills']
let loadSession: Awaited<typeof import('../storage')>['loadSession']

async function buildUseSkillTool() {
  const built = await buildSessionTools(workspaceDir, ['manage_skills'], {
    sessionId: 'skill-runtime-session',
    agentId: 'skill-runtime-agent',
    platformAssignScope: 'self',
  })
  const tool = built.tools.find((entry) => entry.name === 'use_skill')
  assert.ok(tool, 'expected use_skill tool')
  return { built, tool: tool! }
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-skill-runtime-'))
  workspaceDir = path.join(tempDir, 'workspace')
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = workspaceDir
  process.env.SWARMCLAW_BUILD_MODE = '1'
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
  fs.mkdirSync(workspaceDir, { recursive: true })

  const toolsMod = await import('./index')
  buildSessionTools = toolsMod.buildSessionTools

  const storageMod = await import('../storage')
  saveAgents = storageMod.saveAgents
  saveSessions = storageMod.saveSessions
  saveSkills = storageMod.saveSkills
  loadSession = storageMod.loadSession

  saveAgents({
    'skill-runtime-agent': {
      id: 'skill-runtime-agent',
      name: 'Skill Runtime Tester',
      description: 'Tests runtime skill execution.',
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
    'skill-runtime-session': {
      id: 'skill-runtime-session',
      name: 'Skill Runtime Session',
      cwd: workspaceDir,
      user: 'tester',
      provider: 'openai',
      model: 'gpt-test',
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      sessionType: 'human',
      agentId: 'skill-runtime-agent',
      plugins: ['manage_skills'],
      heartbeatEnabled: false,
    },
  })

  saveSkills({
    dispatch_skill: {
      id: 'dispatch_skill',
      name: 'dispatch-helper',
      filename: 'dispatch-helper.md',
      description: 'Dispatch through manage_skills status.',
      content: '# Dispatch Helper\nRun manage_skills status.',
      commandDispatch: {
        kind: 'tool',
        toolName: 'manage_skills',
        argMode: 'raw',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies Skill,
    prompt_skill: {
      id: 'prompt_skill',
      name: 'prompt-helper',
      filename: 'prompt-helper.md',
      description: 'Guidance-only workflow.',
      content: '# Prompt Helper\nFollow this checklist.',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies Skill,
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

describe('use_skill runtime tool', () => {
  it('selects a skill and persists the selection on the session', async () => {
    const { built, tool } = await buildUseSkillTool()
    try {
      const raw = await tool.invoke({ action: 'select', name: 'dispatch-helper' })
      const result = JSON.parse(String(raw)) as Record<string, unknown>
      const session = loadSession('skill-runtime-session')

      assert.equal(result.ok, true)
      assert.equal((result.skill as Record<string, unknown>)?.name, 'dispatch-helper')
      assert.equal(session?.skillRuntimeState?.selectedSkillName, 'dispatch-helper')
    } finally {
      await built.cleanup()
    }
  })

  it('runs an executable skill by dispatching into its bound tool', async () => {
    const { built, tool } = await buildUseSkillTool()
    try {
      const raw = await tool.invoke({
        action: 'run',
        name: 'dispatch-helper',
        toolArgs: { action: 'status', query: 'dispatch helper' },
      })
      const result = JSON.parse(String(raw)) as Record<string, unknown>
      const toolOutput = result.toolOutput as Array<Record<string, unknown>>
      const session = loadSession('skill-runtime-session')

      assert.equal(result.ok, true)
      assert.equal(result.executed, true)
      assert.equal(result.dispatchedTool, 'manage_skills')
      assert.ok(Array.isArray(toolOutput))
      assert.equal(session?.skillRuntimeState?.lastAction, 'run')
      assert.equal(session?.skillRuntimeState?.lastRunToolName, 'manage_skills')
    } finally {
      await built.cleanup()
    }
  })

  it('falls back to prompt guidance for non-executable skills', async () => {
    const { built, tool } = await buildUseSkillTool()
    try {
      const raw = await tool.invoke({ action: 'run', name: 'prompt-helper' })
      const result = JSON.parse(String(raw)) as Record<string, unknown>

      assert.equal(result.ok, true)
      assert.equal(result.executed, false)
      assert.equal(result.mode, 'prompt_guidance')
      assert.match(String(result.guidance || ''), /Prompt Helper/)
    } finally {
      await built.cleanup()
    }
  })
})
