import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { Agent } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let workspaceDir = ''
let runtimeMod: typeof import('./swarmfeed-runtime')
let agentRepoMod: typeof import('./agents/agent-repository')

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    description: 'Social test agent',
    systemPrompt: 'Be useful',
    provider: 'openai',
    model: 'gpt-4o-mini',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    swarmfeedEnabled: true,
    heartbeatEnabled: true,
    swarmfeedAutoPostChannels: ['builders'],
    swarmfeedHeartbeat: {
      enabled: true,
      browseFeed: true,
      postFrequency: 'manual_only',
      autoReply: false,
      autoFollow: false,
      channelsToMonitor: ['builders'],
    },
    ...overrides,
  }
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-swarmfeed-runtime-'))
  workspaceDir = path.join(tempDir, 'workspace')
  fs.mkdirSync(workspaceDir, { recursive: true })
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = workspaceDir
  process.env.SWARMCLAW_BUILD_MODE = '1'

  runtimeMod = await import('./swarmfeed-runtime')
  agentRepoMod = await import('./agents/agent-repository')
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

describe('buildSwarmFeedHeartbeatGuidance', () => {
  it('returns empty string when SwarmFeed social heartbeat is disabled', () => {
    const guidance = runtimeMod.buildSwarmFeedHeartbeatGuidance(
      makeAgent({ swarmfeedEnabled: false }),
    )
    assert.equal(guidance, '')
  })

  it('explains that social automation is inactive when the main heartbeat is disabled', () => {
    const guidance = runtimeMod.buildSwarmFeedHeartbeatGuidance(
      makeAgent({ heartbeatEnabled: false }),
    )
    assert.match(guidance, /currently inactive/i)
    assert.match(guidance, /heartbeat is disabled/i)
  })

  it('includes the manual-only guardrail for autonomous posting', () => {
    const guidance = runtimeMod.buildSwarmFeedHeartbeatGuidance(
      makeAgent({
        swarmfeedHeartbeat: {
          enabled: true,
          browseFeed: false,
          postFrequency: 'manual_only',
          autoReply: false,
          autoFollow: false,
          channelsToMonitor: [],
        },
      }),
    )
    assert.match(guidance, /manual only/i)
    assert.match(guidance, /Do not author new SwarmFeed posts or replies/i)
  })

  it('mentions the recent-post limit for daily posting', () => {
    const guidance = runtimeMod.buildSwarmFeedHeartbeatGuidance(
      makeAgent({
        swarmfeedLastAutoPostAt: Date.now() - 60_000,
        swarmfeedHeartbeat: {
          enabled: true,
          browseFeed: true,
          postFrequency: 'daily',
          autoReply: true,
          autoFollow: true,
          channelsToMonitor: ['builders'],
        },
      }),
    )
    assert.match(guidance, /daily auto-post already happened/i)
  })

  it('describes the on-task-completion policy explicitly', () => {
    const guidance = runtimeMod.buildSwarmFeedHeartbeatGuidance(
      makeAgent({
        swarmfeedHeartbeat: {
          enabled: true,
          browseFeed: true,
          postFrequency: 'on_task_completion',
          autoReply: false,
          autoFollow: false,
          channelsToMonitor: ['builders'],
        },
      }),
    )
    assert.match(guidance, /on task completion/i)
    assert.match(guidance, /completed task/i)
  })
})

describe('canAutoPostToSwarmFeed', () => {
  it('blocks autonomous posting when manual_only is configured', () => {
    const result = runtimeMod.canAutoPostToSwarmFeed(makeAgent())
    assert.equal(result.allowed, false)
    assert.match(result.reason || '', /manual_only/i)
  })

  it('blocks autonomous posting after a recent daily post', () => {
    const result = runtimeMod.canAutoPostToSwarmFeed(
      makeAgent({
        swarmfeedLastAutoPostAt: Date.now() - 60_000,
        swarmfeedHeartbeat: {
          enabled: true,
          browseFeed: true,
          postFrequency: 'daily',
          autoReply: false,
          autoFollow: false,
          channelsToMonitor: [],
        },
      }),
    )
    assert.equal(result.allowed, false)
    assert.match(result.reason || '', /daily autonomous SwarmFeed post/i)
  })

  it('allows daily posting when the last automatic post is older than 24 hours', () => {
    const result = runtimeMod.canAutoPostToSwarmFeed(
      makeAgent({
        swarmfeedLastAutoPostAt: Date.now() - (25 * 60 * 60 * 1000),
        swarmfeedHeartbeat: {
          enabled: true,
          browseFeed: true,
          postFrequency: 'daily',
          autoReply: false,
          autoFollow: false,
          channelsToMonitor: [],
        },
      }),
    )
    assert.equal(result.allowed, true)
  })
})

describe('markSwarmFeedAutoPost', () => {
  it('persists the last auto-post timestamp on the agent record', () => {
    const agent = makeAgent({ id: 'agent-mark-post' })
    agentRepoMod.saveAgent(agent.id, agent)

    runtimeMod.markSwarmFeedAutoPost(agent.id)

    const updated = agentRepoMod.getAgent(agent.id)
    assert.equal(typeof updated?.swarmfeedLastAutoPostAt, 'number')
    assert.ok((updated?.swarmfeedLastAutoPostAt || 0) >= agent.createdAt)
  })
})
