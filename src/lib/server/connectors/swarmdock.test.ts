import assert from 'node:assert/strict'
import test from 'node:test'

import type { Agent } from '@/types/agent'
import type { Connector } from '@/types/connector'
import type { AgentWallet } from '@/types/swarmdock'

import {
  buildDesiredSwarmDockProfile,
  buildSwarmDockAgentBackfill,
  buildSwarmDockSkillPayload,
  diffSwarmDockProfile,
  resolveSwarmDockConfig,
  resolveSwarmDockWalletAddress,
  syncSwarmDockProfile,
} from './swarmdock'

function makeConnector(config: Record<string, string> = {}): Connector {
  return {
    id: 'conn-1',
    name: 'SwarmDock Analyst',
    platform: 'swarmdock',
    agentId: 'agent-1',
    chatroomId: null,
    credentialId: null,
    config,
    isEnabled: true,
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
  }
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'SwarmDock Analyst',
    description: 'Local agent',
    systemPrompt: 'You are helpful.',
    provider: 'openai',
    model: 'gpt-4.1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function makeWallet(overrides: Partial<AgentWallet> = {}): AgentWallet {
  return {
    id: 'wallet-1',
    agentId: 'agent-1',
    walletAddress: '0x000000000000000000000000000000000000dEaD',
    chain: 'base',
    createdAt: 1,
    ...overrides,
  }
}

test('resolveSwarmDockWalletAddress only accepts the selected wallet for the owning agent', () => {
  const agent = makeAgent({ swarmdockWalletId: 'wallet-1' })

  assert.equal(resolveSwarmDockWalletAddress(agent, makeWallet()), '0x000000000000000000000000000000000000dEaD')
  assert.equal(resolveSwarmDockWalletAddress(agent, makeWallet({ id: 'wallet-2' })), '')
  assert.equal(resolveSwarmDockWalletAddress(agent, makeWallet({ agentId: 'agent-2' })), '')
})

test('resolveSwarmDockConfig uses agent defaults and wallet fallback when connector config is incomplete', () => {
  const connector = makeConnector({ autoDiscover: 'true' })
  const agent = makeAgent({
    swarmdockDescription: 'Marketplace specialist',
    swarmdockSkills: ['data-analysis', 'reporting'],
    swarmdockMarketplace: { enabled: true, autoDiscover: false, maxBudgetUsdc: '2500000', autoBid: false, autoBidMaxPrice: '0', taskNotifications: true, preferredCategories: [] },
  })

  const config = resolveSwarmDockConfig(connector, agent, '0x000000000000000000000000000000000000dEaD')

  assert.equal(config.apiUrl, 'https://swarmdock-api.onrender.com')
  assert.equal(config.walletAddress, '0x000000000000000000000000000000000000dEaD')
  assert.equal(config.agentDescription, 'Marketplace specialist')
  assert.equal(config.skills, 'data-analysis,reporting')
  assert.equal(config.autoDiscover, true)
  assert.equal(config.maxBudget, '2500000')
})

test('buildSwarmDockSkillPayload produces stable skill definitions', () => {
  assert.deepEqual(buildSwarmDockSkillPayload('data-analysis'), [{
    skillId: 'data-analysis',
    skillName: 'data analysis',
    description: 'data-analysis capability',
    category: 'data-analysis',
    tags: [],
    inputModes: ['text'],
    outputModes: ['text'],
    pricingModel: 'per-task',
    basePrice: '1000000',
    examplePrompts: [
      'Perform a data analysis task',
      'Help me with data analysis',
      'I need data analysis work done',
      'Complete a data analysis assignment',
      'Handle a data analysis request',
    ],
  }])
})

test('diffSwarmDockProfile is a no-op when the live profile already matches local state', () => {
  const connector = makeConnector()
  const agent = makeAgent({ swarmdockDescription: 'Marketplace specialist', swarmdockSkills: ['data-analysis'] })
  const desired = buildDesiredSwarmDockProfile(
    connector,
    resolveSwarmDockConfig(connector, agent, '0x000000000000000000000000000000000000dEaD'),
    agent,
  )

  const diff = diffSwarmDockProfile({
    id: 'dock-agent-1',
    did: 'did:key:test',
    createdAt: '2026-04-01T12:00:00.000Z',
    displayName: desired.displayName,
    description: desired.description,
    framework: desired.framework,
    modelProvider: desired.modelProvider ?? null,
    modelName: desired.modelName ?? null,
    walletAddress: desired.walletAddress,
    skills: desired.skills,
  }, desired)

  assert.deepEqual(diff.profileFields, {})
  assert.equal(diff.shouldUpdateSkills, false)
})

test('syncSwarmDockProfile patches drifted fields and updates skills only when needed', async () => {
  const desired = {
    displayName: 'SwarmDock Analyst',
    description: 'Marketplace specialist',
    framework: 'swarmclaw',
    modelProvider: 'openai',
    modelName: 'gpt-4.1',
    walletAddress: '0x000000000000000000000000000000000000dEaD',
    skills: buildSwarmDockSkillPayload('data-analysis'),
  }

  const calls: {
    profileUpdates: unknown[]
    skillUpdates: unknown[]
  } = {
    profileUpdates: [],
    skillUpdates: [],
  }

  const result = await syncSwarmDockProfile(
    {
      profile: {
        get: async () => ({
          id: 'dock-agent-1',
          did: 'did:key:test',
          createdAt: '2026-04-01T12:00:00.000Z',
          displayName: 'Old Name',
          description: null,
          framework: null,
          modelProvider: null,
          modelName: null,
          walletAddress: '0x0000000000000000000000000000000000000000',
          skills: [],
        }),
        update: async (fields) => {
          calls.profileUpdates.push(fields)
        },
        updateSkills: async (skills) => {
          calls.skillUpdates.push(skills)
        },
      },
    },
    desired,
  )

  assert.equal(result.updatedProfile, true)
  assert.equal(result.updatedSkills, true)
  assert.deepEqual(calls.profileUpdates, [{
    displayName: 'SwarmDock Analyst',
    description: 'Marketplace specialist',
    framework: 'swarmclaw',
    modelProvider: 'openai',
    modelName: 'gpt-4.1',
    walletAddress: '0x000000000000000000000000000000000000dEaD',
  }])
  assert.equal(calls.skillUpdates.length, 1)
})

test('buildSwarmDockAgentBackfill uses the live profile createdAt timestamp', () => {
  const backfill = buildSwarmDockAgentBackfill({
    id: 'dock-agent-1',
    did: 'did:key:test',
    createdAt: '2026-04-01T12:00:00.000Z',
  })

  assert.equal(backfill.swarmdockAgentId, 'dock-agent-1')
  assert.equal(backfill.swarmdockDid, 'did:key:test')
  assert.equal(backfill.swarmdockListedAt, Date.parse('2026-04-01T12:00:00.000Z'))
})
