import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  buildHeartbeatWakePrompt,
  buildWakeTriggerContext,
  deriveHeartbeatWakeDeliveryMode,
  hasPendingHeartbeatWake,
  mergeHeartbeatWakeRequest,
  requestHeartbeatNow,
  resetHeartbeatWakeStateForTests,
  snapshotPendingHeartbeatWakesForTests,
} from './heartbeat-wake'

describe('heartbeat-wake helpers', () => {
  afterEach(() => {
    resetHeartbeatWakeStateForTests()
  })

  it('retains distinct wake events per target and keeps the latest requested timestamp', () => {
    const first = mergeHeartbeatWakeRequest(undefined, {
      agentId: 'ops',
      reason: 'connector-message',
      source: 'connector:slack',
      resumeMessage: 'Slack says the deploy is red.',
      requestedAt: 100,
    })
    const merged = mergeHeartbeatWakeRequest(first, {
      agentId: 'ops',
      reason: 'schedule',
      source: 'schedule:nightly',
      resumeMessage: 'Nightly check-in fired.',
      requestedAt: 250,
    })

    assert.equal(merged.agentId, 'ops')
    assert.equal(merged.requestedAt, 250)
    assert.equal(merged.events.length, 2)
    assert.deepEqual(merged.events.map((event) => event.reason), ['connector-message', 'schedule'])
  })

  it('deduplicates identical events but preserves differently sourced triggers', () => {
    let wake = mergeHeartbeatWakeRequest(undefined, {
      sessionId: 's1',
      reason: 'schedule',
      source: 'schedule:nightly',
      requestedAt: 1,
    })
    wake = mergeHeartbeatWakeRequest(wake, {
      sessionId: 's1',
      reason: 'schedule',
      source: 'schedule:nightly',
      requestedAt: 2,
    })
    wake = mergeHeartbeatWakeRequest(wake, {
      sessionId: 's1',
      reason: 'schedule',
      source: 'schedule:hourly',
      requestedAt: 3,
    })

    assert.equal(wake.events.length, 2)
    assert.deepEqual(wake.events.map((event) => event.source), ['schedule:hourly', 'schedule:nightly'])
  })

  it('builds a structured trigger context for event-driven wakes', () => {
    const wake = mergeHeartbeatWakeRequest(undefined, {
      sessionId: 'sess-1',
      reason: 'connector-message',
      source: 'connector:slack',
      resumeMessage: 'Slack says deploy is still red.',
      detail: 'Text: prod deploy is still failing health checks',
      requestedAt: 10,
      priority: 90,
    })
    const triggerContext = buildWakeTriggerContext(wake.events, '2026-03-08T15:30:00.000Z')
    const prompt = buildHeartbeatWakePrompt({
      wake,
      basePrompt: 'BASE_PROMPT',
      nowIso: '2026-03-08T15:30:00.000Z',
    })

    assert.match(triggerContext, /## Wake Trigger Context/)
    assert.match(triggerContext, /reason=connector-message \| source=connector:slack \| priority=90/)
    assert.match(triggerContext, /Resume: Slack says deploy is still red\./)
    assert.match(triggerContext, /Detail: Text: prod deploy is still failing health checks/)
    assert.match(prompt, /^BASE_PROMPT/m)
    assert.match(prompt, /Reply HEARTBEAT_OK only if every trigger above is already handled/)
  })

  it('tracks pending wake state while coalesced wakes are queued', () => {
    requestHeartbeatNow({
      sessionId: 'sess-2',
      reason: 'watch_job',
      source: 'watch:http',
      resumeMessage: 'Check the changed API response.',
    })
    requestHeartbeatNow({
      sessionId: 'sess-2',
      reason: 'connector-message',
      source: 'connector:slack',
      resumeMessage: 'Slack asks for an update.',
    })

    assert.equal(hasPendingHeartbeatWake(), true)
    const wakes = snapshotPendingHeartbeatWakesForTests()
    assert.equal(wakes.length, 1)
    assert.deepEqual(
      [...wakes[0].events.map((event) => event.reason)].sort(),
      ['connector-message', 'watch_job'],
    )
  })

  it('forces connector-triggered wakes into tool-only delivery mode', () => {
    const connectorWake = mergeHeartbeatWakeRequest(undefined, {
      sessionId: 'sess-3',
      reason: 'connector-message',
      source: 'connector:whatsapp',
      requestedAt: 1,
    })
    const scheduleWake = mergeHeartbeatWakeRequest(undefined, {
      sessionId: 'sess-4',
      reason: 'schedule',
      source: 'schedule:daily',
      requestedAt: 1,
    })

    assert.equal(deriveHeartbeatWakeDeliveryMode(connectorWake.events), 'tool_only')
    assert.equal(deriveHeartbeatWakeDeliveryMode(scheduleWake.events), 'default')
  })
})
