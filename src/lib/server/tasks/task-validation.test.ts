import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateTaskCompletion } from '@/lib/server/tasks/task-validation'
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

test('validateTaskCompletion does not treat planning prompts with capture language as screenshot delivery', () => {
  const validation = validateTaskCompletion({
    title: 'Planning dry run',
    description: [
      'Plan a local productivity app with quick-capture notes.',
      'Browser QA may include screenshot evidence when available.',
      'Return exactly these sections: Product Scope, Evidence Ledger, Verification.',
    ].join(' '),
    result: [
      'Product scope documented.',
      'Future write scopes include src/app/page.tsx and src/features/board/index.tsx.',
      'Verification: read-only planning dry-run completed with no files changed and no commands run.',
      'Evidence marker: SWARMCLAW_APPBUILD_PLAN_DRYRUN_OK.',
    ].join(' '),
    qualityGate: {
      enabled: true,
      minResultChars: 80,
      minEvidenceItems: 1,
    },
    error: null,
  } as Partial<BoardTask>)

  assert.equal(validation.ok, true, validation.reasons.join('; '))
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

test('validateTaskCompletion does not auto-apply implementation quality gates to scheduled tasks', () => {
  const validation = validateTaskCompletion({
    title: '[Sched] Daily wiki hygiene (run #1)',
    description: 'Run scripts/wiki-hygiene.mjs and post the digest to Slack.',
    result: 'Ran node scripts/wiki-hygiene.mjs and posted the digest to Slack with exit code 0.',
    sourceType: 'schedule',
    sourceScheduleId: 'schedule-wiki',
    error: null,
  } as Partial<BoardTask>)

  assert.equal(validation.ok, true)
})

test('validateTaskCompletion still enforces explicit quality gates on scheduled tasks', () => {
  const validation = validateTaskCompletion({
    title: '[Sched] Daily wiki hygiene (run #1)',
    description: 'Run scripts/wiki-hygiene.mjs and post the digest to Slack.',
    result: 'Ran node scripts/wiki-hygiene.mjs and posted the digest to Slack with exit code 0.',
    sourceType: 'schedule',
    sourceScheduleId: 'schedule-wiki',
    qualityGate: {
      enabled: true,
      minResultChars: 20,
      minEvidenceItems: 2,
      requireVerification: true,
    },
    error: null,
  } as Partial<BoardTask>)

  assert.equal(validation.ok, false)
  assert.ok(validation.reasons.some((reason) => reason.includes('verification evidence is required')))
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

test('validateTaskCompletion respects explicitly disabled quality gates for implementation-hint reviews', () => {
  const validation = validateTaskCompletion({
    title: 'Review app build orchestration readiness',
    description: 'Read-only review of implementation planning readiness.',
    result: 'Review completed. Verified source reference src/lib/server/tasks/task-validation.test.ts. No commands run.',
    qualityGate: {
      enabled: false,
      minResultChars: 20,
      minEvidenceItems: 2,
      requireArtifact: true,
    },
    error: null,
  } as Partial<BoardTask>)

  assert.equal(validation.ok, true, validation.reasons.join('; '))
})

test('validateTaskCompletion accepts short replies when prompt explicitly asks for one', () => {
  const cases = [
    { description: 'Reply with the word PONG only.', result: 'PONG' },
    { description: 'Answer in one word.', result: 'Yes' },
    { description: 'Yes or no: is it raining?', result: 'No' },
    { description: 'Just say hi.', result: 'hi' },
    { description: 'Respond with the number 42 only.', result: '42' },
  ]
  for (const c of cases) {
    const validation = validateTaskCompletion({
      title: 'Ping',
      description: c.description,
      result: c.result,
      error: null,
    } as Partial<BoardTask>)
    assert.equal(validation.ok, true, `expected ok for "${c.description}" -> "${c.result}", got: ${validation.reasons.join('; ')}`)
  }
})

test('validateTaskCompletion still rejects short generic replies when no short-answer signal in prompt', () => {
  const validation = validateTaskCompletion({
    title: 'Summarize the project',
    description: 'Give an overview of the codebase.',
    result: 'Done.',
    error: null,
  } as Partial<BoardTask>)
  assert.equal(validation.ok, false)
  assert.ok(validation.reasons.some((r) => r.includes('Result summary is too short')))
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

test('validateTaskCompletion counts concrete browser smoke details as verification evidence', () => {
  const validation = validateTaskCompletion({
    title: 'Run rebuilt image browser smoke',
    description: 'Use Playwright Chromium to verify the local SwarmClaw Knowledge route.',
    result: [
      'Ran an inline node Playwright script with Chromium.',
      'Target route: /knowledge.',
      'HTTP status: 200.',
      'Final URL: http://127.0.0.1:3456/login.',
      'Ready signal: access-key gate rendered and visible.',
      'Page errors: none.',
      'Request failures: none.',
    ].join(' '),
    qualityGate: {
      enabled: true,
      minResultChars: 20,
      minEvidenceItems: 2,
      requireVerification: true,
    },
    error: null,
  } as Partial<BoardTask>)

  assert.equal(validation.ok, true)
})

test('validateTaskCompletion rejects vague browser claims without concrete verification details', () => {
  const validation = validateTaskCompletion({
    title: 'Run rebuilt image browser smoke',
    description: 'Use a browser to verify the local SwarmClaw Knowledge route.',
    result: 'Opened the browser and the page seemed okay.',
    qualityGate: {
      enabled: true,
      minResultChars: 20,
      minEvidenceItems: 2,
      requireVerification: true,
    },
    error: null,
  } as Partial<BoardTask>)

  assert.equal(validation.ok, false)
  assert.ok(validation.reasons.some((reason) => reason.includes('insufficient completion evidence')))
  assert.ok(validation.reasons.some((reason) => reason.includes('verification evidence is required')))
})
