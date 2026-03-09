import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateTaskCompletion } from './task-validation'
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

test('validateTaskCompletion fails implementation task with unfinished next-step language', () => {
  const validation = validateTaskCompletion({
    title: 'Build weather dashboard',
    description: 'Implement dashboard and run dev server.',
    result: 'I prepared an outline. Next I will run the server once access is granted.',
    error: null,
  } as Partial<BoardTask>)

  assert.equal(validation.ok, false)
  assert.ok(validation.reasons.some((reason) => reason.includes('unfinished work')))
})

test('validateTaskCompletion fails implementation task that requests shell access', () => {
  const validation = validateTaskCompletion({
    title: 'Create blog and run server',
    description: 'Create markdown blog and serve it.',
    result: 'I created the blog file at data/workspace/blog/swarmclaw-blog.md, but I need access to the shell to proceed. Once the access is granted, I will finish setup.',
    error: null,
  } as Partial<BoardTask>)

  assert.equal(validation.ok, false)
  assert.ok(validation.reasons.some((reason) => reason.includes('unfinished work')))
})

test('validateTaskCompletion fails untitled tasks with empty metadata', () => {
  const validation = validateTaskCompletion({
    title: 'Untitled Task',
    description: '',
    result: 'Could you provide more information about what you need?',
    error: null,
  } as Partial<BoardTask>)

  assert.equal(validation.ok, false)
  assert.ok(validation.reasons.some((reason) => reason.includes('metadata is too vague')))
})

test('validateTaskCompletion enforces explicit quality gate evidence requirements', () => {
  const validation = validateTaskCompletion({
    title: 'Ship API migration summary',
    description: 'Summarize the migration outcome.',
    result: 'Migration summary completed successfully with no extra artifacts included.',
    qualityGate: {
      enabled: true,
      minResultChars: 20,
      minEvidenceItems: 2,
      requireArtifact: true,
    },
    error: null,
  } as Partial<BoardTask>)

  assert.equal(validation.ok, false)
  assert.ok(validation.reasons.some((reason) => reason.includes('insufficient completion evidence')))
  assert.ok(validation.reasons.some((reason) => reason.includes('artifact evidence is required')))
})

test('validateTaskCompletion passes explicit quality gate when evidence checks are met', () => {
  const validation = validateTaskCompletion({
    title: 'Ship API migration summary',
    description: 'Summarize the migration outcome.',
    result: 'Ran npm test and tests passed. Updated src/api/migrate.ts. Uploaded evidence: sandbox:/api/uploads/migration-proof.png.',
    artifacts: [{
      url: 'sandbox:/api/uploads/migration-proof.png',
      type: 'image',
      filename: 'migration-proof.png',
    }],
    qualityGate: {
      enabled: true,
      minResultChars: 20,
      minEvidenceItems: 2,
      requireArtifact: true,
      requireVerification: true,
    },
    error: null,
  } as Partial<BoardTask>)

  assert.equal(validation.ok, true)
})
