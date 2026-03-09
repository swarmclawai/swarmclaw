import assert from 'node:assert/strict'
import { test } from 'node:test'
import { routeTaskIntent } from './capability-router'

test('routeTaskIntent keeps recall-style prompts as general intent', () => {
  const decision = routeTaskIntent(
    'What token did we store earlier as e2e_validation_token? Reply only with the token.',
    ['memory', 'web_search'],
    null,
  )
  assert.equal(decision.intent, 'general')
})

test('routeTaskIntent keeps coding prompts prioritized over memory keywords', () => {
  const decision = routeTaskIntent(
    'Build and test a calculator app, then remember the final path in memory.',
    ['memory', 'shell', 'files'],
    null,
  )
  assert.equal(decision.intent, 'coding')
})

test('routeTaskIntent keeps hybrid research-plus-media prompts in research intent', () => {
  const decision = routeTaskIntent(
    'Can you tell me more if there is any news related to the US-Iran war, and can you send me some screenshots and give me a summary and maybe send me a voice note about it?',
    ['web_search', 'web_fetch', 'browser', 'manage_connectors'],
    null,
  )

  assert.equal(decision.intent, 'research')
  assert.deepEqual(decision.preferredTools, ['web_search', 'web_fetch', 'browser', 'connector_message_tool'])
})

test('routeTaskIntent treats direct voice-note delivery as outreach', () => {
  const decision = routeTaskIntent(
    'Send me a voice note over WhatsApp summarizing what changed.',
    ['manage_connectors'],
    null,
  )

  assert.equal(decision.intent, 'outreach')
  assert.deepEqual(decision.preferredTools, ['connector_message_tool'])
})

test('routeTaskIntent treats keep-watching update requests as research even without explicit news keywords', () => {
  const decision = routeTaskIntent(
    'Tell me about the Iran war, keep watching for meaningful updates, and avoid duplicate reminders.',
    ['web_search', 'manage_schedules'],
    null,
  )

  assert.equal(decision.intent, 'research')
  assert.deepEqual(decision.preferredTools, ['web_search', 'web_fetch'])
})
