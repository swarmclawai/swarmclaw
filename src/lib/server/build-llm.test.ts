import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before, beforeEach } from 'node:test'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let workspaceDir = ''
let resolveGenerationModelConfig: Awaited<typeof import('./build-llm')>['resolveGenerationModelConfig']
let saveAgents: Awaited<typeof import('./storage')>['saveAgents']
let saveSessions: Awaited<typeof import('./storage')>['saveSessions']

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-build-llm-'))
  workspaceDir = path.join(tempDir, 'workspace')
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = workspaceDir
  process.env.SWARMCLAW_BUILD_MODE = '1'
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
  fs.mkdirSync(workspaceDir, { recursive: true })

  const mod = await import('./build-llm')
  resolveGenerationModelConfig = mod.resolveGenerationModelConfig

  const storage = await import('./storage')
  saveAgents = storage.saveAgents
  saveSessions = storage.saveSessions
})

beforeEach(() => {
  saveAgents({})
  saveSessions({})
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
})

test('resolveGenerationModelConfig prefers an explicit non-CLI candidate over stored session/agent config', () => {
  saveAgents({
    agent1: {
      id: 'agent1',
      name: 'Agent 1',
      provider: 'ollama',
      model: 'phi4',
      apiEndpoint: 'http://127.0.0.1:11434',
    },
  })
  saveSessions({
    session1: {
      id: 'session1',
      name: 'Session 1',
      cwd: workspaceDir,
      user: 'tester',
      provider: 'ollama',
      model: 'llama3.2',
      apiEndpoint: 'http://127.0.0.1:11434',
      claudeSessionId: null,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      sessionType: 'human',
      agentId: 'agent1',
    },
  })
  const resolved = resolveGenerationModelConfig({
    sessionId: 'session1',
    preferred: {
      provider: 'ollama',
      model: 'qwen3.5',
      apiEndpoint: 'http://127.0.0.1:11434',
    },
  })

  assert.equal(resolved.provider, 'ollama')
  assert.equal(resolved.model, 'qwen3.5')
  assert.equal(resolved.apiEndpoint, 'http://127.0.0.1:11434')
})

test('resolveGenerationModelConfig skips CLI-only preferences and falls back to the current session config', () => {
  saveSessions({
    session1: {
      id: 'session1',
      name: 'Session 1',
      cwd: workspaceDir,
      user: 'tester',
      provider: 'ollama',
      model: 'llama3.2',
      apiEndpoint: 'http://127.0.0.1:11434',
      claudeSessionId: null,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      sessionType: 'human',
    },
  })

  const resolved = resolveGenerationModelConfig({
    sessionId: 'session1',
    preferred: {
      provider: 'claude-cli',
      model: 'ignored',
    },
  })

  assert.equal(resolved.provider, 'ollama')
  assert.equal(resolved.model, 'llama3.2')
})

test('resolveGenerationModelConfig skips unusable preferred providers and falls back to the owning agent route targets', () => {
  saveAgents({
    agent1: {
      id: 'agent1',
      name: 'Agent 1',
      provider: 'claude-cli',
      model: '',
      delegationEnabled: false,
      routingTargets: [{
        id: 'route-1',
        provider: 'ollama',
        model: 'phi4',
        apiEndpoint: 'http://127.0.0.1:11434',
        priority: 1,
      }],
    },
  })

  const resolved = resolveGenerationModelConfig({
    agentId: 'agent1',
    preferred: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      credentialId: null,
    },
  })

  assert.equal(resolved.provider, 'ollama')
  assert.equal(resolved.model, 'phi4')
})
