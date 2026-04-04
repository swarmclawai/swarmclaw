import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before, beforeEach } from 'node:test'
import type { ChatOpenAI } from '@langchain/openai'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
  CREDENTIAL_SECRET: process.env.CREDENTIAL_SECRET,
}

let tempDir = ''
let workspaceDir = ''
let buildChatModel: Awaited<typeof import('./build-llm')>['buildChatModel']
let resolveGenerationModelConfig: Awaited<typeof import('./build-llm')>['resolveGenerationModelConfig']
let encryptKey: Awaited<typeof import('./storage')>['encryptKey']
let saveAgents: Awaited<typeof import('./storage')>['saveAgents']
let saveCredentials: Awaited<typeof import('./storage')>['saveCredentials']
let saveSessions: Awaited<typeof import('./storage')>['saveSessions']

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-build-llm-'))
  workspaceDir = path.join(tempDir, 'workspace')
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = workspaceDir
  process.env.SWARMCLAW_BUILD_MODE = '1'
  process.env.CREDENTIAL_SECRET = '33'.repeat(32)
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
  fs.mkdirSync(workspaceDir, { recursive: true })

  const mod = await import('./build-llm')
  buildChatModel = mod.buildChatModel
  resolveGenerationModelConfig = mod.resolveGenerationModelConfig

  const storage = await import('./storage')
  encryptKey = storage.encryptKey
  saveAgents = storage.saveAgents
  saveCredentials = storage.saveCredentials
  saveSessions = storage.saveSessions
})

beforeEach(() => {
  saveAgents({})
  saveCredentials({})
  saveSessions({})
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  if (originalEnv.CREDENTIAL_SECRET === undefined) delete process.env.CREDENTIAL_SECRET
  else process.env.CREDENTIAL_SECRET = originalEnv.CREDENTIAL_SECRET
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

test('resolveGenerationModelConfig skips excluded providers and falls back to an available routed model', () => {
  saveAgents({
    agent1: {
      id: 'agent1',
      name: 'Agent 1',
      provider: 'openclaw',
      model: 'default',
      gatewayProfileId: 'gateway-1',
      routingTargets: [{
        id: 'route-1',
        provider: 'ollama',
        model: 'phi4',
        apiEndpoint: 'http://127.0.0.1:11434',
        priority: 1,
      }],
    },
  })

  saveSessions({
    session1: {
      id: 'session1',
      name: 'Session 1',
      cwd: workspaceDir,
      user: 'tester',
      provider: 'openclaw',
      model: 'default',
      gatewayProfileId: 'gateway-1',
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
    agentId: 'agent1',
    excludeProviders: ['openclaw'],
  })

  assert.equal(resolved.provider, 'ollama')
  assert.equal(resolved.model, 'phi4')
})

test('buildChatModel keeps local Ollama local even when a credential and :cloud model name are present', () => {
  saveCredentials({
    'cred-1': {
      id: 'cred-1',
      provider: 'ollama',
      name: 'Ollama Cloud',
      encryptedKey: encryptKey('ollama-cloud-key'),
      createdAt: Date.now(),
    },
  } as Record<string, {
    id: string
    provider: string
    name: string
    encryptedKey: string
    createdAt: number
  }>)

  const llm = buildChatModel({
    provider: 'ollama',
    model: 'glm-5:cloud',
    ollamaMode: 'local',
    apiKey: null,
    credentialId: 'cred-1',
  }) as ChatOpenAI

  assert.equal(llm.model, 'glm-5:cloud')
  assert.equal(llm.apiKey, 'ollama')
  assert.equal(llm.clientConfig?.baseURL, 'http://localhost:11434/v1')
})

test('buildChatModel uses Ollama Cloud only when explicit cloud mode is selected', () => {
  saveCredentials({
    'cred-1': {
      id: 'cred-1',
      provider: 'ollama',
      name: 'Ollama Cloud',
      encryptedKey: encryptKey('ollama-cloud-key'),
      createdAt: Date.now(),
    },
  } as Record<string, {
    id: string
    provider: string
    name: string
    encryptedKey: string
    createdAt: number
  }>)

  const llm = buildChatModel({
    provider: 'ollama',
    model: 'glm-5:cloud',
    ollamaMode: 'cloud',
    apiKey: null,
    credentialId: 'cred-1',
  }) as ChatOpenAI

  assert.equal(llm.model, 'glm-5')
  assert.equal(llm.apiKey, 'ollama-cloud-key')
  assert.equal(llm.clientConfig?.baseURL, 'https://ollama.com/v1')
})

test('resolveGenerationModelConfig uses explicit cloud mode when repairing a stale Ollama credential reference', () => {
  saveCredentials({
    'cred-1': {
      id: 'cred-1',
      provider: 'ollama',
      name: 'Ollama Cloud',
      encryptedKey: encryptKey('ollama-cloud-key'),
      createdAt: Date.now(),
    },
  } as Record<string, {
    id: string
    provider: string
    name: string
    encryptedKey: string
    createdAt: number
  }>)

  const resolved = resolveGenerationModelConfig({
    preferred: {
      provider: 'ollama',
      model: 'glm-5:cloud',
      ollamaMode: 'cloud',
      credentialId: 'stale-ollama-cred',
    },
  })

  assert.equal(resolved.provider, 'ollama')
  assert.equal(resolved.model, 'glm-5:cloud')
  assert.equal(resolved.apiEndpoint, 'https://ollama.com')
})

test('resolveGenerationModelConfig defaults legacy Ollama preferences to local when no explicit mode is stored', () => {
  saveCredentials({
    'cred-1': {
      id: 'cred-1',
      provider: 'ollama',
      name: 'Ollama Cloud',
      encryptedKey: encryptKey('ollama-cloud-key'),
      createdAt: Date.now(),
    },
  } as Record<string, {
    id: string
    provider: string
    name: string
    encryptedKey: string
    createdAt: number
  }>)

  const resolved = resolveGenerationModelConfig({
    preferred: {
      provider: 'ollama',
      model: 'glm-5:cloud',
      credentialId: 'cred-1',
    },
  })

  assert.equal(resolved.provider, 'ollama')
  assert.equal(resolved.model, 'glm-5:cloud')
  assert.equal(resolved.apiEndpoint, 'http://localhost:11434')
  assert.equal(resolved.ollamaMode, undefined)
})
