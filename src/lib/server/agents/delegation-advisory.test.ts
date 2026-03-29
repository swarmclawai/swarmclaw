import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { Agent } from '@/types'
import type { MessageClassification } from '@/lib/server/chat-execution/message-classifier'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let advisory: typeof import('@/lib/server/agents/delegation-advisory')
let storage: typeof import('@/lib/server/storage')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-delegation-advisory-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
  fs.mkdirSync(process.env.WORKSPACE_DIR, { recursive: true })

  advisory = await import('@/lib/server/agents/delegation-advisory')
  storage = await import('@/lib/server/storage')
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

function makeAgent(params: Partial<Agent> & Pick<Agent, 'id' | 'name'>): Agent {
  const now = Date.now()
  return {
    id: params.id,
    name: params.name,
    role: params.role || 'worker',
    description: params.description || '',
    systemPrompt: params.systemPrompt || '',
    provider: params.provider || 'openai',
    model: params.model || 'gpt-test',
    capabilities: params.capabilities || [],
    delegationEnabled: params.delegationEnabled ?? false,
    delegationTargetMode: params.delegationTargetMode || 'all',
    delegationTargetAgentIds: params.delegationTargetAgentIds || [],
    createdAt: params.createdAt || now,
    updatedAt: params.updatedAt || now,
  } as Agent
}

function makeClassification(overrides: Partial<MessageClassification>): MessageClassification {
  return {
    taskIntent: 'general',
    isDeliverableTask: false,
    isBroadGoal: false,
    hasHumanSignals: false,
    hasSignificantEvent: false,
    isResearchSynthesis: false,
    workType: 'general',
    wantsScreenshots: false,
    wantsOutboundDelivery: false,
    wantsVoiceDelivery: false,
    explicitToolRequests: [],
    confidence: 0.9,
    ...overrides,
  }
}

function saveAgents(agents: Agent[]): Record<string, Agent> {
  const record = Object.fromEntries(agents.map((agent) => [agent.id, agent]))
  storage.saveAgents(record)
  storage.saveTasks({})
  storage.saveSessions({})
  return record
}

describe('delegation-advisory', () => {
  it('prefers a builder over a coordinator for coding work', () => {
    const agents = saveAgents([
      makeAgent({
        id: 'ceo',
        name: 'CEO',
        role: 'coordinator',
        capabilities: ['coordination', 'delegation', 'operations'],
        delegationEnabled: true,
      }),
      makeAgent({
        id: 'builder',
        name: 'Builder',
        role: 'worker',
        capabilities: ['coding', 'implementation', 'debugging'],
      }),
      makeAgent({
        id: 'writer',
        name: 'Writer',
        role: 'worker',
        capabilities: ['writing', 'editing'],
      }),
    ])

    const profile = advisory.buildDelegationTaskProfile({
      classification: makeClassification({
        isDeliverableTask: true,
        workType: 'coding',
      }),
    })
    const result = advisory.resolveDelegationAdvisory({
      currentAgent: agents.ceo,
      agents,
      profile,
      delegationTargetMode: 'all',
      delegationTargetAgentIds: [],
    })

    assert.equal(result.shouldDelegate, true)
    assert.equal(result.style, 'managerial')
    assert.equal(result.recommended?.agentId, 'builder')
    assert.match(advisory.formatDelegationRationale(result.recommended), /coding/i)
  })

  it('prefers a researcher for research work', () => {
    const agents = saveAgents([
      makeAgent({
        id: 'ceo',
        name: 'CEO',
        role: 'coordinator',
        capabilities: ['coordination', 'delegation', 'operations'],
        delegationEnabled: true,
      }),
      makeAgent({
        id: 'builder',
        name: 'Builder',
        role: 'worker',
        capabilities: ['coding', 'implementation', 'debugging'],
      }),
      makeAgent({
        id: 'researcher',
        name: 'Researcher',
        role: 'worker',
        capabilities: ['research', 'analysis', 'summarization'],
      }),
    ])

    const profile = advisory.buildDelegationTaskProfile({
      classification: makeClassification({
        isResearchSynthesis: true,
        workType: 'research',
      }),
    })
    const result = advisory.resolveDelegationAdvisory({
      currentAgent: agents.ceo,
      agents,
      profile,
      delegationTargetMode: 'all',
      delegationTargetAgentIds: [],
    })

    assert.equal(result.shouldDelegate, true)
    assert.equal(result.recommended?.agentId, 'researcher')
  })

  it('does not advise delegation when self is already as capable as peers', () => {
    const agents = saveAgents([
      makeAgent({
        id: 'builder-a',
        name: 'Builder A',
        role: 'worker',
        capabilities: ['coding', 'implementation', 'debugging'],
        delegationEnabled: true,
      }),
      makeAgent({
        id: 'builder-b',
        name: 'Builder B',
        role: 'worker',
        capabilities: ['coding', 'implementation', 'debugging'],
      }),
    ])

    const profile = advisory.buildDelegationTaskProfile({
      classification: makeClassification({
        isDeliverableTask: true,
        workType: 'coding',
      }),
    })
    const result = advisory.resolveDelegationAdvisory({
      currentAgent: agents['builder-a'],
      agents,
      profile,
      delegationTargetMode: 'all',
      delegationTargetAgentIds: [],
    })

    assert.equal(result.recommended?.agentId, 'builder-b')
    assert.equal(result.shouldDelegate, false)
  })
})
