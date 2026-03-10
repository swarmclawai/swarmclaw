import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Message } from '@/types'
import {
  buildAgentRuntimeCapabilities,
  buildEnabledToolsAutonomyGuidance,
  buildNoToolsGuidance,
  pruneSuppressedHeartbeatStreamMessage,
  shouldApplySessionFreshnessReset,
} from '@/lib/server/chat-execution/chat-execution'

describe('pruneSuppressedHeartbeatStreamMessage', () => {
  it('removes a trailing streaming assistant heartbeat artifact', () => {
    const messages: Message[] = [
      { role: 'assistant', text: 'real reply', time: 1, kind: 'chat' },
      { role: 'assistant', text: 'HEARTBEAT_OK', time: 2, streaming: true },
    ]

    const changed = pruneSuppressedHeartbeatStreamMessage(messages)

    assert.equal(changed, true)
    assert.deepEqual(messages, [
      { role: 'assistant', text: 'real reply', time: 1, kind: 'chat' },
    ])
  })

  it('keeps non-streaming or user messages intact', () => {
    const nonStreaming: Message[] = [
      { role: 'assistant', text: 'HEARTBEAT_OK', time: 2, kind: 'heartbeat' },
    ]
    const userTail: Message[] = [
      { role: 'user', text: 'ping', time: 3, streaming: true },
    ]

    assert.equal(pruneSuppressedHeartbeatStreamMessage(nonStreaming), false)
    assert.equal(pruneSuppressedHeartbeatStreamMessage(userTail), false)
    assert.equal(nonStreaming.length, 1)
    assert.equal(userTail.length, 1)
  })

  it('applies freshness resets beyond heartbeat but skips eval runs', () => {
    assert.equal(shouldApplySessionFreshnessReset('chat'), true)
    assert.equal(shouldApplySessionFreshnessReset('heartbeat'), true)
    assert.equal(shouldApplySessionFreshnessReset('eval'), false)
  })

  it('does not advertise tool capabilities when no plugins are enabled', () => {
    assert.deepEqual(buildAgentRuntimeCapabilities([]), ['heartbeats', 'autonomous_loop', 'multi_agent_chat'])
    assert.deepEqual(buildAgentRuntimeCapabilities(['web']), ['tools', 'heartbeats', 'autonomous_loop', 'multi_agent_chat'])
  })

  it('tells no-tool agents to report missing capability instead of asking for approval', () => {
    const guidance = buildNoToolsGuidance().join('\n')
    assert.match(guidance, /No runtime tools are available/i)
    assert.match(guidance, /Do not imply that a normal read-only action is waiting on user permission/i)
    assert.match(guidance, /blocked by runtime policy in this session/i)
  })

  it('tells tool-enabled agents to use enabled tools autonomously before asking for permission', () => {
    const guidance = buildEnabledToolsAutonomyGuidance().join('\n')
    assert.match(guidance, /Runtime tools are already available for normal use/i)
    assert.match(guidance, /Do not request that a tool be enabled or switched on/i)
    assert.match(guidance, /Do not ask the user for permission before using enabled tools/i)
    assert.match(guidance, /attempt that tool path before asking the user to do the work manually/i)
    assert.match(guidance, /current or external information and web tools are enabled/i)
    assert.match(guidance, /file, report, dashboard, JSON, or other workspace artifact/i)
    assert.match(guidance, /inspect the local repository, runtime, or filesystem state/i)
    assert.match(guidance, /Treat capability policy blocks and explicit platform feature gates as the real boundaries/i)
  })
})
