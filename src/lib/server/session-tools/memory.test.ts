import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { executeMemoryAction, shouldAutoCaptureAutonomousTurn } from './memory'

describe('executeMemoryAction', () => {
  it('defaults empty payloads to listing memories instead of reporting an unknown action', async () => {
    const result = await executeMemoryAction({}, { agentId: 'agent-test', sessionId: 'session-test', messages: [] })
    assert.doesNotMatch(String(result), /Unknown action/)
    assert.equal(typeof result, 'string')
  })

  it('preserves an existing category when update omits category', async () => {
    const scopeId = `memory-test-${Date.now()}`
    const ctx = { agentId: scopeId, sessionId: scopeId, messages: [] }
    const stored = await executeMemoryAction({
      action: 'store',
      title: `Workspace Root ${scopeId}`,
      value: '/tmp/swarmclaw-workspace',
      category: 'operations/environment',
    }, ctx)
    const memoryId = /id: ([^)]+)/.exec(String(stored))?.[1]
    assert.ok(memoryId, `expected memory id in store result: ${stored}`)

    try {
      const updated = await executeMemoryAction({
        action: 'update',
        id: memoryId,
        title: `Workspace Directory ${scopeId}`,
      }, ctx)
      assert.match(String(updated), /Updated memory/)

      const fetched = await executeMemoryAction({ action: 'get', id: memoryId }, ctx)
      assert.match(String(fetched), /operations\/environment\/Workspace Directory/)
    } finally {
      await executeMemoryAction({ action: 'delete', id: memoryId }, ctx)
    }
  })

  it('normalizes wrapped store payloads that provide content instead of value', async () => {
    const scopeId = `memory-test-${Date.now()}-content`
    const ctx = { agentId: scopeId, sessionId: scopeId, messages: [] }

    const result = await executeMemoryAction({
      input: JSON.stringify({
        action: 'store',
        title: `Project Kodiak ${scopeId}`,
        category: 'projects/decisions',
        content: 'Project Kodiak uses the codename "amber-fox" and the freeze date is April 18, 2026.',
      }),
    }, ctx)

    assert.match(String(result), /Stored memory/)
    assert.doesNotMatch(String(result), /requires a non-empty value/i)
  })

  it('accepts common memory write aliases like note, body, text, and memory', async () => {
    const aliases = ['note', 'body', 'text', 'memory'] as const

    for (const alias of aliases) {
      const scopeId = `memory-test-${Date.now()}-${alias}`
      const ctx = { agentId: scopeId, sessionId: scopeId, messages: [] }
      const result = await executeMemoryAction({
        action: 'store',
        title: `Alias ${alias} ${scopeId}`,
        category: 'projects/decisions',
        [alias]: 'Project Kodiak uses the codename "amber-fox" and the freeze date is April 21, 2026.',
      }, ctx)
      assert.match(String(result), /Stored memory/)
      assert.doesNotMatch(String(result), /requires a non-empty value/i)
    }
  })

  it('captures substantive internal autonomous turns only when tools were used', () => {
    assert.equal(shouldAutoCaptureAutonomousTurn({
      source: 'heartbeat-wake',
      response: 'Inspected the failing deploy, pulled the latest logs, and identified a bad health-check path in the service config.',
      toolEvents: [{ name: 'shell' }],
    }), true)

    assert.equal(shouldAutoCaptureAutonomousTurn({
      source: 'heartbeat-wake',
      response: 'HEARTBEAT_OK',
      toolEvents: [{ name: 'shell' }],
    }), false)

    assert.equal(shouldAutoCaptureAutonomousTurn({
      source: 'heartbeat-wake',
      response: 'I found the issue and documented it.',
      toolEvents: [],
    }), false)
  })
})
