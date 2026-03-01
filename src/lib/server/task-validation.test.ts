import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateTaskCompletion } from './task-validation.ts'
import type { BoardTask } from '@/types'

test('validateTaskCompletion fails screenshot delivery tasks without artifact evidence', () => {
  const validation = validateTaskCompletion({
    title: 'Take screenshot and send it every minute',
    description: 'Schedule a screenshot capture and deliver it to the user.',
    result: 'Existing schedule verified for taking screenshots every minute. Waiting for next run.',
    error: null,
  } as Partial<BoardTask>)

  assert.equal(validation.ok, false)
  assert.ok(validation.reasons.some((reason) => reason.includes('Screenshot delivery task is missing artifact evidence')))
})

test('validateTaskCompletion accepts screenshot delivery tasks with upload artifact evidence', () => {
  const validation = validateTaskCompletion({
    title: 'Take screenshot and send it',
    description: 'Capture Wikipedia and return the file to the user.',
    result: 'Captured and sent screenshot successfully: sandbox:/api/uploads/1234-wikipedia.png',
    error: null,
  } as Partial<BoardTask>)

  assert.equal(validation.ok, true)
})

test('validateTaskCompletion accepts concise non-implementation result summaries', () => {
  const validation = validateTaskCompletion({
    title: 'Answer greeting',
    description: 'Respond to a basic hello prompt.',
    result: 'Hello! How can I help you today?',
    error: null,
  } as Partial<BoardTask>)

  assert.equal(validation.ok, true)
})

test('validateTaskCompletion still enforces stricter minimum for implementation tasks', () => {
  const validation = validateTaskCompletion({
    title: 'Fix retry bug',
    description: 'Implement queue retry fixes and verify.',
    result: 'Patched queue retry bug.',
    error: null,
  } as Partial<BoardTask>)

  assert.equal(validation.ok, false)
  assert.ok(validation.reasons.some((reason) => reason.includes('Result summary is too short')))
})
