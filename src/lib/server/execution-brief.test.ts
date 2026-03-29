import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildExecutionBrief, buildExecutionBriefContextBlock, serializeExecutionBriefForDelegation } from './execution-brief'
import type { Session, SessionWorkingState } from '@/types'

test('buildExecutionBrief prefers working state and folds in mission and run-context fallback data', () => {
  const session = {
    id: 's1',
    name: 'Main Session',
    cwd: '/tmp/project',
    user: 'tester',
    provider: 'openai',
    model: 'gpt-test',
    claudeSessionId: null,
    messages: [],
    createdAt: 1,
    lastActiveAt: 1,
    runContext: {
      objective: 'Fallback objective',
      constraints: ['Do not change the API'],
      keyFacts: ['The build already passes locally.'],
      discoveries: ['The failing path is only used in staging.'],
      failedApproaches: ['Restarting the worker did not help.'],
      currentPlan: ['Fallback step'],
      completedSteps: [],
      blockers: ['Waiting on staging credentials.'],
      parentContext: 'Parent asked for a contained fix.',
      updatedAt: 1,
      version: 1,
    },
  } satisfies Partial<Session> as Session

  const workingState = {
    sessionId: 's1',
    objective: 'Ship the release fix safely',
    summary: 'Auth mismatch isolated to staging.',
    constraints: ['Do not change the API'],
    successCriteria: ['Restore staging deploys'],
    status: 'progress',
    nextAction: 'Request deploy approval',
    planSteps: [
      { id: 'p1', text: 'Request deploy approval', status: 'active', createdAt: 1, updatedAt: 1 },
      { id: 'p2', text: 'Roll staging credentials', status: 'resolved', createdAt: 1, updatedAt: 1 },
    ],
    confirmedFacts: [
      { id: 'f1', statement: 'Auth mismatch isolated to staging.', source: 'tool', status: 'active', createdAt: 1, updatedAt: 1 },
    ],
    artifacts: [
      { id: 'a1', label: 'deploy.log', kind: 'file', path: '/tmp/project/deploy.log', status: 'active', createdAt: 1, updatedAt: 1 },
    ],
    decisions: [],
    blockers: [
      { id: 'b1', summary: 'Deploy approval is pending.', kind: 'approval', nextAction: 'Request deploy approval', status: 'active', createdAt: 1, updatedAt: 1 },
    ],
    openQuestions: [],
    hypotheses: [],
    evidenceRefs: [
      { id: 'e1', type: 'tool', summary: 'Checked deploy logs', value: '403 from staging auth', sessionId: 's1', createdAt: 1 },
    ],
    createdAt: 1,
    updatedAt: 1,
  } satisfies SessionWorkingState

  const brief = buildExecutionBrief({ session, workingState })

  assert.equal(brief.objective, 'Ship the release fix safely')
  assert.equal(brief.summary, 'Auth mismatch isolated to staging.')
  assert.equal(brief.status, 'progress')
  assert.equal(brief.nextAction, 'Request deploy approval')
  assert.equal(brief.plan[0]?.text, 'Request deploy approval')
  assert.equal(brief.blockers[0], 'Deploy approval is pending. | next: Request deploy approval')
  assert.ok(brief.facts.some((entry) => /auth mismatch isolated to staging/i.test(entry)))
  assert.ok(brief.artifacts.some((entry) => /deploy\.log/i.test(entry)))
  assert.equal(brief.parentContext, 'Parent asked for a contained fix.')
})

test('buildExecutionBriefContextBlock renders a single canonical state block', () => {
  const brief = buildExecutionBrief({
    session: {
      id: 's2',
      name: 'Session',
      cwd: '/tmp',
      user: 'tester',
      provider: 'openai',
      model: 'gpt-test',
      claudeSessionId: null,
      messages: [],
      createdAt: 1,
      lastActiveAt: 1,
    } satisfies Partial<Session> as Session,
    workingState: {
      sessionId: 's2',
      objective: 'Finish the rollout',
      summary: 'Everything is ready except final verification.',
      constraints: ['No schema changes'],
      successCriteria: ['Verify production traffic'],
      status: 'progress',
      nextAction: 'Run the final smoke test',
      planSteps: [{ id: 'p1', text: 'Run the final smoke test', status: 'active', createdAt: 1, updatedAt: 1 }],
      confirmedFacts: [{ id: 'f1', statement: 'Staging already passed.', source: 'tool', status: 'active', createdAt: 1, updatedAt: 1 }],
      artifacts: [],
      decisions: [],
      blockers: [],
      openQuestions: [],
      hypotheses: [],
      evidenceRefs: [],
      createdAt: 1,
      updatedAt: 1,
    },
  })

  const block = buildExecutionBriefContextBlock(brief)
  assert.match(block, /## Execution Brief/)
  assert.match(block, /Objective: Finish the rollout/)
  assert.match(block, /Next action: Run the final smoke test/)
  assert.match(block, /Staging already passed\./)
})

test('serializeExecutionBriefForDelegation creates a bounded handoff summary', () => {
  const text = serializeExecutionBriefForDelegation({
    sessionId: 's3',
    objective: 'Repair the deployment pipeline',
    summary: 'The regression is isolated to the release job.',
    status: 'blocked',
    nextAction: 'Fix the release job',
    plan: [
      { text: 'Fix the release job', status: 'active' },
      { text: 'Verify deploy output', status: 'resolved' },
    ],
    blockers: ['Approval required before production deploy.'],
    facts: ['The build already passes locally.'],
    artifacts: ['/tmp/project/release.log'],
    constraints: ['Keep the current release shape.'],
    successCriteria: ['Production deploy completes'],
    evidenceRefs: [],
    parentContext: 'Parent is waiting on a concise status update.',
  })

  assert.ok(text)
  assert.match(String(text), /Objective: Repair the deployment pipeline/)
  assert.match(String(text), /Blockers: Approval required before production deploy\./)
  assert.match(String(text), /Parent context: Parent is waiting on a concise status update\./)
})
