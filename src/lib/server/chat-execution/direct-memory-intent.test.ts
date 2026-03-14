import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildDirectMemoryRecallResponse,
  parseDirectMemoryIntentResponse,
} from '@/lib/server/chat-execution/direct-memory-intent'

describe('direct-memory-intent', () => {
  it('parses a store classification payload', () => {
    const parsed = parseDirectMemoryIntentResponse(`
      Here you go:
      {"action":"store","confidence":0.97,"title":"Launch marker","value":"My launch marker is ALPHA-7","acknowledgement":"I'll remember that your launch marker is ALPHA-7."}
    `)

    assert.deepEqual(parsed, {
      action: 'store',
      confidence: 0.97,
      title: 'Launch marker',
      value: 'My launch marker is ALPHA-7',
      acknowledgement: 'I\'ll remember that your launch marker is ALPHA-7.',
    })
  })

  it('parses a recall classification payload', () => {
    const parsed = parseDirectMemoryIntentResponse('{"action":"recall","confidence":0.88,"query":"launch marker","missResponse":"I do not have your launch marker in memory yet."}')

    assert.deepEqual(parsed, {
      action: 'recall',
      confidence: 0.88,
      query: 'launch marker',
      missResponse: 'I do not have your launch marker in memory yet.',
    })
  })

  it('parses an update classification payload', () => {
    const parsed = parseDirectMemoryIntentResponse('{"action":"update","confidence":0.91,"title":"Launch marker","value":"My launch marker is ALPHA-8","acknowledgement":"I\'ll use your updated launch marker going forward."}')

    assert.deepEqual(parsed, {
      action: 'update',
      confidence: 0.91,
      title: 'Launch marker',
      value: 'My launch marker is ALPHA-8',
      acknowledgement: 'I\'ll use your updated launch marker going forward.',
    })
  })

  it('returns null for malformed memory-write payloads with no durable value', () => {
    const parsed = parseDirectMemoryIntentResponse('{"action":"store","confidence":0.9,"title":"Launch marker"}')

    assert.equal(parsed, null)
  })

  it('renders a natural recall response from memory search output', () => {
    const response = buildDirectMemoryRecallResponse({
      action: 'recall',
      confidence: 0.9,
      query: 'launch marker',
      missResponse: 'I do not have your launch marker in memory yet.',
    }, '[mem_123] (agent:agent-1) knowledge/facts/Launch marker: My launch marker is ALPHA-7')

    assert.equal(response, 'Your launch marker is ALPHA-7.')
  })

  it('renders a natural recall response for stored user-fact phrasing', () => {
    const response = buildDirectMemoryRecallResponse({
      action: 'recall',
      confidence: 0.9,
      query: 'live marker',
      missResponse: 'I do not have your live marker in memory yet.',
    }, "[mem_123] (agent:agent-1) knowledge/facts/Live Marker: User's live marker is ALPHA-7")

    assert.equal(response, 'Your live marker is ALPHA-7.')
  })

  it('uses the classifier miss response when no memory is found', () => {
    const response = buildDirectMemoryRecallResponse({
      action: 'recall',
      confidence: 0.9,
      query: 'launch marker',
      missResponse: 'I do not have your launch marker in memory yet.',
    }, 'No memories found.')

    assert.equal(response, 'I do not have your launch marker in memory yet.')
  })
})
