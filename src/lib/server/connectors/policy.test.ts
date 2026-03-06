import assert from 'node:assert/strict'
import test from 'node:test'
import type { Connector, Session } from '@/types'
import type { InboundMessage } from './types'
import {
  buildConnectorConversationKey,
  buildConnectorDoctorWarnings,
  buildInboundDedupeKey,
  getConnectorSessionStaleness,
  isReplyToLastOutbound,
  mergeInboundMessages,
  normalizeConnectorGroupPolicy,
  normalizeConnectorReplyMode,
  normalizeConnectorSessionScope,
  normalizeConnectorThreadBinding,
  resetConnectorSessionRuntime,
  resolveConnectorSessionPolicy,
  shouldReplyToInboundMessage,
  textMentionsAlias,
} from './policy'

function makeConnector(config: Record<string, string> = {}): Connector {
  return {
    id: 'connector-1',
    name: 'Test Connector',
    platform: 'slack',
    agentId: 'agent-1',
    chatroomId: null,
    credentialId: 'cred-1',
    config,
    isEnabled: true,
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
  }
}

function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'slack',
    channelId: 'C123',
    channelName: 'general',
    senderId: 'U123',
    senderName: 'Alice',
    text: 'hello',
    isGroup: false,
    ...overrides,
  }
}

test('normalizers fall back safely', () => {
  assert.equal(normalizeConnectorSessionScope('THREAD', 'channel'), 'thread')
  assert.equal(normalizeConnectorSessionScope('unknown', 'channel'), 'channel')
  assert.equal(normalizeConnectorReplyMode('ALL'), 'all')
  assert.equal(normalizeConnectorReplyMode('weird'), 'first')
  assert.equal(normalizeConnectorThreadBinding('STRICT'), 'strict')
  assert.equal(normalizeConnectorThreadBinding('weird'), 'prefer')
  assert.equal(normalizeConnectorGroupPolicy('MENTION'), 'mention')
  assert.equal(normalizeConnectorGroupPolicy('nope'), 'reply-or-mention')
})

test('policy resolves DM and group defaults', () => {
  const dmPolicy = resolveConnectorSessionPolicy(makeConnector(), makeInbound())
  assert.equal(dmPolicy.scope, 'channel-peer')
  assert.equal(dmPolicy.groupPolicy, 'reply-or-mention')
  assert.equal(dmPolicy.typingIndicators, true)

  const groupPolicy = resolveConnectorSessionPolicy(makeConnector(), makeInbound({ isGroup: true }))
  assert.equal(groupPolicy.scope, 'channel')
})

test('policy resolves connector runtime defaults', () => {
  const policy = resolveConnectorSessionPolicy(
    makeConnector({
      thinkingLevel: 'high',
      providerOverride: 'openai',
      modelOverride: 'gpt-4.1-mini',
      typingIndicators: 'false',
    }),
    makeInbound(),
  )
  assert.equal(policy.thinkingLevel, 'high')
  assert.equal(policy.providerOverride, 'openai')
  assert.equal(policy.modelOverride, 'gpt-4.1-mini')
  assert.equal(policy.typingIndicators, false)
})

test('conversation key uses thread scope when configured', () => {
  const connector = makeConnector({ sessionScope: 'thread', threadBinding: 'strict' })
  const msg = makeInbound({ isGroup: true, channelId: 'C999', threadId: 'T321' })
  const policy = resolveConnectorSessionPolicy(connector, msg)
  const key = buildConnectorConversationKey({ connector, msg, agentId: 'agent-1', policy })
  assert.equal(key, 'connector:connector-1:agent:agent-1:channel:C999:thread:T321')
})

test('staleness detects idle and max age expiry', () => {
  const connector = makeConnector({ idleTimeoutSec: '10', maxAgeSec: '20' })
  const msg = makeInbound()
  const policy = resolveConnectorSessionPolicy(connector, msg)
  const session = {
    id: 's1',
    createdAt: 0,
    lastActiveAt: 0,
    messages: [{ role: 'user', text: 'hi', time: 0 }],
  } as Partial<Session>
  assert.deepEqual(getConnectorSessionStaleness(session, policy, 11_000), { stale: true, reason: 'idle_timeout:10' })
  assert.deepEqual(getConnectorSessionStaleness(session, policy, 25_000), { stale: true, reason: 'idle_timeout:10' })
})

test('connector staleness supports daily reset mode', () => {
  const connector = makeConnector({ sessionResetMode: 'daily', sessionDailyResetAt: '04:00', idleTimeoutSec: '0', maxAgeSec: '999999' })
  const msg = makeInbound()
  const policy = resolveConnectorSessionPolicy(connector, msg)
  const session = {
    id: 's2',
    createdAt: Date.parse('2026-03-04T00:00:00.000Z'),
    lastActiveAt: Date.parse('2026-03-05T03:30:00.000Z'),
    messages: [{ role: 'user', text: 'hi', time: 0 }],
  } as Partial<Session>
  assert.deepEqual(
    getConnectorSessionStaleness(session, { ...policy, resetTimezone: 'UTC' }, Date.parse('2026-03-05T10:00:00.000Z')),
    { stale: true, reason: 'daily_reset:04:00' },
  )
})

test('resetConnectorSessionRuntime clears conversation state', () => {
  const session = {
    id: 's1',
    name: 'test',
    cwd: '/',
    user: 'u',
    provider: 'openai',
    model: 'gpt-4.1',
    claudeSessionId: 'claude',
    codexThreadId: 'codex',
    opencodeSessionId: 'open',
    delegateResumeIds: { claudeCode: 'x', codex: 'y', opencode: 'z', gemini: 'g' },
    messages: [{ role: 'user', text: 'hi', time: 0 }],
    createdAt: 0,
    lastActiveAt: 0,
    connectorContext: { lastOutboundMessageId: 'm1' },
  } as Session
  const cleared = resetConnectorSessionRuntime(session, 'idle_timeout:10')
  assert.equal(cleared, 1)
  assert.deepEqual(session.messages, [])
  assert.equal(session.claudeSessionId, null)
  assert.equal(session.connectorContext?.lastOutboundMessageId, null)
  assert.equal(session.connectorContext?.lastResetReason, 'idle_timeout:10')
})

test('reply policy uses first reply once per session', () => {
  const connector = makeConnector({ replyMode: 'first' })
  const msg = makeInbound({ messageId: 'in-1' })
  const policy = resolveConnectorSessionPolicy(connector, msg)
  assert.deepEqual(shouldReplyToInboundMessage({ msg, policy }), { replyToMessageId: 'in-1', threadId: undefined })
  assert.deepEqual(shouldReplyToInboundMessage({
    msg,
    policy,
    session: { connectorContext: { lastOutboundMessageId: 'out-1' } } as Partial<Session>,
  }), { replyToMessageId: undefined, threadId: undefined })
})

test('reply detection matches last outbound', () => {
  const session = { connectorContext: { lastOutboundMessageId: 'out-1' } } as Partial<Session>
  assert.equal(isReplyToLastOutbound(makeInbound({ replyToMessageId: 'out-1' }), session), true)
  assert.equal(isReplyToLastOutbound(makeInbound({ replyToMessageId: 'out-2' }), session), false)
})

test('mergeInboundMessages combines text and media', () => {
  const merged = mergeInboundMessages([
    makeInbound({ text: 'first' }),
    makeInbound({ text: 'second', media: [{ type: 'image', url: 'https://example.com/a.png' }] }),
  ])
  assert.equal(merged.text, 'first\nsecond')
  assert.equal(merged.media?.length, 1)
})

test('textMentionsAlias catches plain and @ mentions', () => {
  assert.equal(textMentionsAlias('hey swarmy can you help?', ['Swarmy']), true)
  assert.equal(textMentionsAlias('@swarmy help', ['Swarmy']), true)
  assert.equal(textMentionsAlias('hello team', ['Swarmy']), false)
})

test('dedupe key prefers explicit message ids', () => {
  const connector = makeConnector()
  assert.equal(buildInboundDedupeKey(connector, makeInbound({ messageId: 'm123' })), 'msg:connector-1:C123:m123')
  assert.match(buildInboundDedupeKey(connector, makeInbound({ text: 'Hello there' })), /^text:connector-1:C123:U123:none:none:hello there$/)
})

test('doctor warnings flag unsafe defaults', () => {
  const warnings = buildConnectorDoctorWarnings({
    connector: makeConnector({
      sessionScope: 'main',
      groupPolicy: 'open',
      replyMode: 'off',
      threadBinding: 'off',
      idleTimeoutSec: '0',
      maxAgeSec: '0',
      inboundDebounceMs: '0',
    }),
    msg: makeInbound({ isGroup: true }),
  })
  assert.ok(warnings.some((item) => item.includes('blend unrelated connector conversations')))
  assert.ok(warnings.some((item) => item.includes('may speak in group chats without being mentioned')))
  assert.ok(warnings.some((item) => item.includes('Inbound debounce is disabled')))
})

test('doctor warnings flag daily reset timezone and chatroom overrides', () => {
  const connector = makeConnector({
    sessionResetMode: 'daily',
    sessionDailyResetAt: '04:00',
    providerOverride: 'openai',
    modelOverride: 'gpt-4.1-mini',
  })
  connector.chatroomId = 'chatroom-1'
  const warnings = buildConnectorDoctorWarnings({
    connector,
    msg: makeInbound(),
  })
  assert.ok(warnings.some((item) => item.includes('server timezone')))
  assert.ok(warnings.some((item) => item.includes('routes to a chatroom')))
})
