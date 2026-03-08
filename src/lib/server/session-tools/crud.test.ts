import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Agent } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let buildCrudTools: Awaited<typeof import('./crud')>['buildCrudTools']
let loadAgents: Awaited<typeof import('../storage')>['loadAgents']
let saveAgents: Awaited<typeof import('../storage')>['saveAgents']

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-crud-test-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
  fs.mkdirSync(process.env.WORKSPACE_DIR, { recursive: true })

  const crudMod = await import('./crud')
  buildCrudTools = crudMod.buildCrudTools

  const storageMod = await import('../storage')
  loadAgents = storageMod.loadAgents
  saveAgents = storageMod.saveAgents

  const agents = loadAgents({ includeTrashed: true }) as Record<string, Agent>
  agents['agent-soul-test'] = {
    id: 'agent-soul-test',
    name: 'Soul Test Agent',
    description: 'Agent used for CRUD soul validation tests',
    systemPrompt: '',
    provider: 'ollama',
    model: 'glm-5:cloud',
    plugins: ['manage_agents'],
    tools: ['manage_agents'],
    platformAssignScope: 'self',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  saveAgents(agents)
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

describe('manage_agents soul validation', () => {
  it('rejects non-string soul payloads so preferences do not leak into agent config', async () => {
    const tools = buildCrudTools({
      cwd: process.cwd(),
      ctx: { agentId: 'agent-soul-test', platformAssignScope: 'self' },
      hasPlugin: (name) => name === 'manage_agents',
      hasTool: (name) => name === 'manage_agents',
      cleanupFns: [],
      commandTimeoutMs: 1_000,
      claudeTimeoutMs: 1_000,
      cliProcessTimeoutMs: 1_000,
      persistDelegateResumeId: () => {},
      readStoredDelegateResumeId: () => null,
      resolveCurrentSession: () => null,
      activePlugins: ['manage_agents'],
    })

    const manageAgents = tools.find((tool) => tool.name === 'manage_agents')
    assert.ok(manageAgents, 'expected manage_agents tool')

    const raw = await manageAgents!.invoke({
      action: 'update',
      id: 'agent-soul-test',
      soul: {
        preferences: {
          programmingLanguage: 'Rust',
        },
      },
    })

    assert.match(
      String(raw),
      /manage_agents data\.soul must be a plain instruction string/i,
    )
  })

  it('deduplicates repeated manage_agents create calls in the same session', async () => {
    const tools = buildCrudTools({
      cwd: process.cwd(),
      ctx: { sessionId: 'agent-dedupe-session', agentId: 'agent-soul-test', platformAssignScope: 'all' },
      hasPlugin: (name) => name === 'manage_agents',
      hasTool: (name) => name === 'manage_agents',
      cleanupFns: [],
      commandTimeoutMs: 1_000,
      claudeTimeoutMs: 1_000,
      cliProcessTimeoutMs: 1_000,
      persistDelegateResumeId: () => {},
      readStoredDelegateResumeId: () => null,
      resolveCurrentSession: () => null,
      activePlugins: ['manage_agents'],
    })

    const manageAgents = tools.find((tool) => tool.name === 'manage_agents')
    assert.ok(manageAgents, 'expected manage_agents tool')

    const firstRaw = await manageAgents!.invoke({
      action: 'create',
      name: 'Session Dedupe Worker',
      soul: 'Coordinates a worker lane and never stores user memory.',
    })
    const secondRaw = await manageAgents!.invoke({
      action: 'create',
      name: 'Session Dedupe Worker',
      soul: 'Coordinates a worker lane and never stores user memory.',
    })

    const first = JSON.parse(String(firstRaw)) as Record<string, unknown>
    const second = JSON.parse(String(secondRaw)) as Record<string, unknown>
    const created = Object.values(loadAgents({ includeTrashed: true }) as Record<string, Agent & { createdInSessionId?: string }>)
      .filter((agent) => agent.createdInSessionId === 'agent-dedupe-session')

    assert.equal(created.length, 1)
    assert.equal(second.id, first.id)
    assert.equal(second.deduplicated, true)
  })
})
