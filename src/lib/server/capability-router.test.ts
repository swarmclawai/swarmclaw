import assert from 'node:assert/strict'
import { test } from 'node:test'
import { routeTaskIntent } from './capability-router.ts'

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
