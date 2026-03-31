import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Agent, ProviderType } from '@/types'
import { isWorkerOnlyAgent, buildWorkerOnlyAgentMessage } from './agent-availability'

describe('isWorkerOnlyAgent', () => {
  const CLI_PROVIDERS = ['claude-cli', 'codex-cli', 'opencode-cli', 'gemini-cli', 'copilot-cli', 'openclaw'] satisfies ProviderType[]
  const NON_CLI_PROVIDERS = ['openai', 'anthropic', 'google', 'deepseek', 'groq', 'together'] satisfies ProviderType[]

  function withProvider(provider: unknown): Pick<Agent, 'provider'> {
    return { provider } as Pick<Agent, 'provider'>
  }

  for (const provider of CLI_PROVIDERS) {
    it(`returns true for ${provider}`, () => {
      assert.equal(isWorkerOnlyAgent(withProvider(provider)), true)
    })
  }

  for (const provider of NON_CLI_PROVIDERS) {
    it(`returns false for ${provider}`, () => {
      assert.equal(isWorkerOnlyAgent(withProvider(provider)), false)
    })
  }

  it('returns false for null', () => {
    assert.equal(isWorkerOnlyAgent(null), false)
  })

  it('returns false for undefined', () => {
    assert.equal(isWorkerOnlyAgent(undefined), false)
  })

  it('returns false for empty provider string', () => {
    assert.equal(isWorkerOnlyAgent(withProvider('')), false)
  })
})

describe('buildWorkerOnlyAgentMessage', () => {
  it('returns default message without action', () => {
    const msg = buildWorkerOnlyAgentMessage({ name: 'Claude CLI' })
    assert.equal(
      msg,
      'Claude CLI is a CLI-based agent and cannot join chatrooms. CLI agents can only be used for direct chats and delegation.',
    )
  })

  it('includes action when provided', () => {
    const msg = buildWorkerOnlyAgentMessage({ name: 'Claude CLI' }, 'join chatrooms')
    assert.equal(
      msg,
      'Claude CLI is a CLI-based agent and cannot join chatrooms. CLI agents can only be used for direct chats and delegation.',
    )
  })

  it('uses fallback name for null agent', () => {
    const msg = buildWorkerOnlyAgentMessage(null)
    assert.equal(
      msg,
      'This agent is a CLI-based agent and cannot join chatrooms. CLI agents can only be used for direct chats and delegation.',
    )
  })

  it('uses fallback name for agent with empty name', () => {
    const msg = buildWorkerOnlyAgentMessage({ name: '  ' })
    assert.equal(
      msg,
      'This agent is a CLI-based agent and cannot join chatrooms. CLI agents can only be used for direct chats and delegation.',
    )
  })

  it('uses custom action in message', () => {
    const msg = buildWorkerOnlyAgentMessage({ name: 'Codex' }, 'be added to this room')
    assert.equal(
      msg,
      'Codex is a CLI-based agent and cannot be added to this room. CLI agents can only be used for direct chats and delegation.',
    )
  })
})
