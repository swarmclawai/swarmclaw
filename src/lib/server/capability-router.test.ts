import assert from 'node:assert/strict'
import { test } from 'node:test'
import { routeTaskIntent } from './capability-router'
import type { MessageClassification } from '@/lib/server/chat-execution/message-classifier'

test('routeTaskIntent keeps recall-style prompts as general intent', () => {
  const decision = routeTaskIntent(
    'What token did we store earlier as e2e_validation_token? Reply only with the token.',
    ['memory', 'web_search'],
    null,
    makeClassification({ taskIntent: 'general' }),
  )
  assert.equal(decision.intent, 'general')
})

test('routeTaskIntent keeps coding prompts prioritized over memory keywords', () => {
  const decision = routeTaskIntent(
    'Build and test a calculator app, then remember the final path in memory.',
    ['memory', 'shell', 'files'],
    null,
    makeClassification({ taskIntent: 'coding', workType: 'coding' }),
  )
  assert.equal(decision.intent, 'coding')
})

test('routeTaskIntent keeps hybrid research-plus-media prompts in research intent', () => {
  const decision = routeTaskIntent(
    'Can you tell me more if there is any news related to the US-Iran war, and can you send me some screenshots and give me a summary and maybe send me a voice note about it?',
    ['web_search', 'web_fetch', 'browser', 'manage_connectors'],
    null,
    makeClassification({
      taskIntent: 'research',
      workType: 'research',
      wantsScreenshots: true,
      wantsVoiceDelivery: true,
      wantsOutboundDelivery: true,
      isResearchSynthesis: true,
    }),
  )

  assert.equal(decision.intent, 'research')
  assert.deepEqual(decision.preferredTools, ['web_search', 'web_fetch', 'browser', 'connector_message_tool'])
})

test('routeTaskIntent treats direct voice-note delivery as outreach', () => {
  const decision = routeTaskIntent(
    'Send me a voice note over WhatsApp summarizing what changed.',
    ['manage_connectors'],
    null,
    makeClassification({
      taskIntent: 'outreach',
      workType: 'writing',
      wantsVoiceDelivery: true,
      wantsOutboundDelivery: true,
    }),
  )

  assert.equal(decision.intent, 'outreach')
  assert.deepEqual(decision.preferredTools, ['connector_message_tool'])
})

test('routeTaskIntent treats keep-watching update requests as research even without explicit news keywords', () => {
  const decision = routeTaskIntent(
    'Tell me about the Iran war, keep watching for meaningful updates, and avoid duplicate reminders.',
    ['web_search', 'web_fetch', 'manage_schedules'],
    null,
    makeClassification({
      taskIntent: 'research',
      workType: 'research',
      isResearchSynthesis: true,
    }),
  )

  assert.equal(decision.intent, 'research')
  assert.deepEqual(decision.preferredTools, ['web_search', 'web_fetch'])
})

test('routeTaskIntent uses structured classification when available', () => {
  const classification: MessageClassification = {
    taskIntent: 'browsing',
    isDeliverableTask: true,
    isBroadGoal: false,
    hasHumanSignals: false,
    hasSignificantEvent: false,
    isResearchSynthesis: true,
    workType: 'research',
    wantsScreenshots: true,
    wantsOutboundDelivery: false,
    wantsVoiceDelivery: false,
    explicitToolRequests: ['browser'],
    confidence: 0.92,
  }

  const decision = routeTaskIntent(
    'Review this story and show me screenshots.',
    ['web_search', 'web_fetch', 'browser'],
    null,
    classification,
  )

  assert.equal(decision.intent, 'browsing')
  assert.deepEqual(decision.preferredTools, ['browser', 'web_fetch'])
})

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
