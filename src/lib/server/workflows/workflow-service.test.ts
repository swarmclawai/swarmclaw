import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-workflow-service-'))
process.env.DATA_DIR = tempDir
process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
process.env.SWARMCLAW_DAEMON_AUTOSTART = '0'

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

async function seedWorkflowAgents() {
  const storageMod = await import('@/lib/server/storage')
  const storage = storageMod
  for (const agent of [
    { id: '92b8cd6c', name: 'Builder' },
    { id: 'c2cd6ff9', name: 'Reviewer QA' },
    { id: 'default', name: 'Coordinator' },
  ]) {
    storage.upsertStoredItem('agents', agent.id, {
      id: agent.id,
      name: agent.name,
      provider: 'ollama',
      model: 'test-model',
      systemPrompt: 'test',
      createdAt: 1,
      updatedAt: 1,
    })
  }
  return storage
}

test('workflow service drafts without creating tasks and launches backlog bundle tasks with fan-in dependencies', async () => {
  const storage = await seedWorkflowAgents()
  const workflows = await import('@/lib/server/workflows/workflow-service')

  const beforeTaskCount = Object.keys(storage.loadTasks()).length
  const draft = workflows.createWorkflowPlan({
    title: 'Crypto audit',
    goal: 'Audit the project structure without changing files.',
    cwd: '/tmp/project',
    allowedScopes: ['services/', 'tests/'],
  })
  assert.equal(draft.ok, true)
  if (!draft.ok) return

  const afterPlanTaskCount = Object.keys(storage.loadTasks()).length
  const discoveryDraft = draft.payload.bundle.tasks.find((task) => task.key === 'discovery')
  const fanInDraft = draft.payload.bundle.tasks.find((task) => task.key === 'fan_in')
  const launched = workflows.createWorkflowBundle(draft.payload.bundle)
  assert.equal(launched.ok, true)
  if (!launched.ok) return

  const tasks = storage.loadTasks()
  const createdTasks = launched.payload.taskIds.map((id) => tasks[id])
  const fanIn = createdTasks.find((task) => task.workflow?.bundleTaskKey === 'fan_in')
  const worker = createdTasks.find((task) => task.workflow?.bundleTaskKey === 'discovery')
  assert.ok(fanIn)
  assert.ok(worker)
  const initialStatuses = createdTasks.map((task) => task.status)

  const redactionFixture = 'token' + '=' + 'fixture-value'
  fanIn.result = `WF-REVIEW-FAN-IN\nAccepted. ${redactionFixture} should be redacted.`
  fanIn.status = 'completed'
  tasks[fanIn.id] = fanIn
  storage.saveTasks(tasks)

  const ledger = workflows.getWorkflowLedger(launched.payload.run.id)
  assert.equal(ledger.ok, true)
  if (!ledger.ok) return
  const fanInLedger = ledger.payload.entries.find((entry) => entry.taskKey === 'fan_in')

  assert.equal(beforeTaskCount, 0)
  assert.equal(afterPlanTaskCount, 0)
  assert.equal(draft.payload.createsTasks, false)
  assert.equal(draft.payload.routing.strategy, 'deterministic_bundle')
  assert.equal(draft.payload.approvalGate.status, 'review_required')
  assert.equal(draft.payload.approvalGate.requiredBeforeLaunch, true)
  assert.equal(draft.payload.approvalGate.reviewerAgentId, 'c2cd6ff9')
  assert.match(draft.payload.risks.join('\n'), /Approved launch creates backlog tasks first/)
  assert.match(draft.payload.verification.join('\n'), /createsTasks=false/)
  assert.equal(draft.payload.quarantine.enabled, false)
  assert.match(String(discoveryDraft?.description || ''), /first non-empty line of your final answer MUST be exactly/)
  assert.match(String(fanInDraft?.description || ''), /upstream task results injected into this task context/)
  assert.equal(launched.payload.run.status, 'waiting')
  assert.equal(launched.payload.taskIds.length, 3)
  assert.deepEqual(initialStatuses, ['backlog', 'backlog', 'backlog'])
  assert.equal(fanIn.blockedBy?.length || 0, 2)
  assert.equal(worker.blocks?.includes(fanIn.id), true)
  assert.equal(ledger.payload.entries.length, 3)
  assert.match(String(fanInLedger?.resultPreview || ''), new RegExp('token' + '=\\[REDACTED\\]'))
})

test('workflow planner classifies write-capable goals and quarantines untrusted inputs without creating tasks', async () => {
  const storage = await seedWorkflowAgents()
  const workflows = await import('@/lib/server/workflows/workflow-service')

  const beforeTaskCount = Object.keys(storage.loadTasks()).length
  const draft = workflows.createWorkflowPlan({
    title: 'Bug hunt from logs',
    goal: 'Debug failed trading pipeline behavior from copied external logs, then propose fixes.',
    cwd: '/tmp/project',
    safetyProfile: {
      allowedScopes: ['services/', 'tests/'],
      maxTotalTasks: 8,
    },
  })
  assert.equal(draft.ok, true)
  if (!draft.ok) return
  const afterTaskCount = Object.keys(storage.loadTasks()).length

  assert.equal(beforeTaskCount, afterTaskCount)
  assert.equal(draft.payload.classification, 'bug_hunt')
  assert.equal(draft.payload.routing.strategy, 'dynamic_draft')
  assert.equal(draft.payload.quarantine.enabled, true)
  assert.equal(draft.payload.bundle.queueImmediately, false)
  assert.equal(draft.payload.bundle.safetyProfile.approvalRequired, true)
  assert.equal(draft.payload.bundle.safetyProfile.mode, 'standard')
  assert.deepEqual(draft.payload.bundle.safetyProfile.allowedScopes, ['services/', 'tests/'])
  assert.match(draft.payload.risks.join('\n'), /Write-capable follow-up work/)
  assert.match(draft.payload.approvalGate.rejectionTriggers.join('\n'), /Allowed scopes are missing/)
  assert.match(draft.payload.bundle.tasks[0]?.description || '', /Quarantine mode is enabled/)
})

test('workflow service blocks immediate queueing when approval remains required', async () => {
  const workflows = await import('@/lib/server/workflows/workflow-service')
  const result = workflows.createWorkflowBundle({
    title: 'Unsafe queue attempt',
    goal: 'Queue immediately while approval remains required.',
    queueImmediately: true,
    safetyProfile: { mode: 'read_only', approvalRequired: true },
    tasks: [{
      key: 'one',
      title: 'One',
      description: 'One',
      agentId: 'missing',
    }],
  })

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.status, 409)
  assert.match(result.payload.error, /Approval-required/)
})

test('workflow continuation blocks completed runs with marker mismatches or blocked fan-in disposition', async () => {
  const storage = await seedWorkflowAgents()
  const workflows = await import('@/lib/server/workflows/workflow-service')

  const draft = workflows.createWorkflowPlan({
    title: 'Marker gate',
    goal: 'Review workflow evidence without changing files.',
  })
  assert.equal(draft.ok, true)
  if (!draft.ok) return

  const launched = workflows.createWorkflowBundle(draft.payload.bundle)
  assert.equal(launched.ok, true)
  if (!launched.ok) return

  const tasks = storage.loadTasks()
  for (const taskId of launched.payload.taskIds) {
    const task = tasks[taskId]
    assert.ok(task)
    const marker = task.workflow?.expectedMarker || 'WF-MISSING'
    task.status = 'completed'
    task.result = task.workflow?.bundleTaskKey === 'discovery'
      ? `Wrong marker\nAccepted discovery evidence. Files changed: none. Verification: prompt contract checked.`
      : task.workflow?.bundleTaskKey === 'fan_in'
        ? `${marker}\nBlocked next wave. Files changed: none. Verification: upstream results reviewed. Blockers: marker mismatch. Decision: blocked.`
        : `${marker}\nNo blocking findings. Files changed: none. Verification: prompt contract checked. Blockers: none. Decision: Pass.`
    task.updatedAt += 1
  }
  storage.saveTasks(tasks)

  const continuation = workflows.continueWorkflowRun(launched.payload.run.id)
  assert.equal(continuation.ok, true)
  if (!continuation.ok) return
  assert.equal(continuation.payload.state, 'blocked')
  assert.equal(continuation.payload.nextAction, 'request_checkpoint')
  assert.match(continuation.payload.summary, /missed expected first-line markers/)
  assert.match(continuation.payload.summary, /blocked disposition/)
})

test('workflow continuation marks protocol run completed when all workflow tasks pass', async () => {
  const storage = await seedWorkflowAgents()
  const workflows = await import('@/lib/server/workflows/workflow-service')

  const draft = workflows.createWorkflowPlan({
    title: 'Done gate',
    goal: 'Verify workflow completion status without changing files.',
  })
  assert.equal(draft.ok, true)
  if (!draft.ok) return

  const launched = workflows.createWorkflowBundle(draft.payload.bundle)
  assert.equal(launched.ok, true)
  if (!launched.ok) return

  const tasks = storage.loadTasks()
  for (const taskId of launched.payload.taskIds) {
    const task = tasks[taskId]
    assert.ok(task)
    const marker = task.workflow?.expectedMarker || 'WF-MISSING'
    task.status = 'completed'
    task.result = `${marker}\nAccepted. Files changed: none. Verification: workflow smoke checked. Blockers: none. Decision: Pass.`
    task.updatedAt += 1
  }
  storage.saveTasks(tasks)

  const continuation = workflows.continueWorkflowRun(launched.payload.run.id)
  assert.equal(continuation.ok, true)
  if (!continuation.ok) return
  assert.equal(continuation.payload.state, 'done')
  assert.equal(continuation.payload.ledger.status, 'completed')

  const ledger = workflows.getWorkflowLedger(launched.payload.run.id)
  assert.equal(ledger.ok, true)
  if (!ledger.ok) return
  assert.equal(ledger.payload.status, 'completed')
})

test('workflow continuation drafts the next bundle but stops for approval by default', async () => {
  const storage = await seedWorkflowAgents()
  const workflows = await import('@/lib/server/workflows/workflow-service')

  const draft = workflows.createWorkflowPlan({
    title: 'Approval continuation',
    goal: 'Review workflow evidence without changing files.',
  })
  assert.equal(draft.ok, true)
  if (!draft.ok) return

  const launched = workflows.createWorkflowBundle(draft.payload.bundle)
  assert.equal(launched.ok, true)
  if (!launched.ok) return

  const tasks = storage.loadTasks()
  for (const taskId of launched.payload.taskIds) {
    const task = tasks[taskId]
    assert.ok(task)
    const marker = task.workflow?.expectedMarker || 'WF-MISSING'
    task.status = 'completed'
    task.result = `${marker}\nAccepted. Files changed: none. Verification: workflow smoke checked. Blockers: none. Decision: Pass.`
    task.updatedAt += 1
  }
  storage.saveTasks(tasks)
  const beforeTaskCount = Object.keys(storage.loadTasks()).length

  const continuation = workflows.continueWorkflowRun(launched.payload.run.id, {
    continueUntilDone: true,
    goal: 'Continue safely from accepted evidence.',
  })
  assert.equal(continuation.ok, true)
  if (!continuation.ok) return

  assert.equal(Object.keys(storage.loadTasks()).length, beforeTaskCount)
  assert.equal(continuation.payload.state, 'checkpoint')
  assert.equal(continuation.payload.nextAction, 'request_checkpoint')
  assert.equal(continuation.payload.draft?.createsTasks, false)
  assert.equal(continuation.payload.launched, null)
  assert.equal(continuation.payload.policy?.canAutoLaunch, false)
  assert.match(continuation.payload.summary, /waiting for operator approval/)
})

test('workflow continuation can auto-create the next read-only bundle as backlog tasks when explicitly allowed', async () => {
  const storage = await seedWorkflowAgents()
  const workflows = await import('@/lib/server/workflows/workflow-service')

  const draft = workflows.createWorkflowPlan({
    title: 'Auto continuation',
    goal: 'Audit workflow evidence without changing files.',
    allowedScopes: ['docs/'],
  })
  assert.equal(draft.ok, true)
  if (!draft.ok) return

  const launched = workflows.createWorkflowBundle(draft.payload.bundle)
  assert.equal(launched.ok, true)
  if (!launched.ok) return

  const tasks = storage.loadTasks()
  for (const taskId of launched.payload.taskIds) {
    const task = tasks[taskId]
    assert.ok(task)
    const marker = task.workflow?.expectedMarker || 'WF-MISSING'
    task.status = 'completed'
    task.result = `${marker}\nAccepted. Files changed: none. Verification: workflow smoke checked. Blockers: none. Decision: Pass.`
    task.updatedAt += 1
  }
  storage.saveTasks(tasks)
  const beforeTaskCount = Object.keys(storage.loadTasks()).length

  const continuation = workflows.continueWorkflowRun(launched.payload.run.id, {
    continueUntilDone: true,
    autoLaunch: true,
    goal: 'Audit the next safe read-only slice without changing files.',
    allowedScopes: ['docs/'],
    safetyProfile: {
      mode: 'read_only',
      approvalRequired: false,
      quarantine: false,
      maxTotalTasks: 12,
    },
  })
  assert.equal(continuation.ok, true)
  if (!continuation.ok) return

  const afterTasks = storage.loadTasks()
  const created = continuation.payload.launched?.taskIds.map((taskId) => afterTasks[taskId])
  assert.equal(Object.keys(afterTasks).length, beforeTaskCount + 3)
  assert.equal(continuation.payload.state, 'waiting')
  assert.equal(continuation.payload.nextAction, 'launched_next_bundle')
  assert.equal(continuation.payload.policy?.canAutoLaunch, true)
  assert.equal(continuation.payload.launched?.queued, false)
  assert.deepEqual(created?.map((task) => task?.status), ['backlog', 'backlog', 'backlog'])
})

test('workflow continuation stops on max iteration fuse', async () => {
  const storage = await seedWorkflowAgents()
  const workflows = await import('@/lib/server/workflows/workflow-service')

  const draft = workflows.createWorkflowPlan({
    title: 'Fuse continuation',
    goal: 'Review workflow evidence without changing files.',
  })
  assert.equal(draft.ok, true)
  if (!draft.ok) return

  const launched = workflows.createWorkflowBundle(draft.payload.bundle)
  assert.equal(launched.ok, true)
  if (!launched.ok) return

  const tasks = storage.loadTasks()
  for (const taskId of launched.payload.taskIds) {
    const task = tasks[taskId]
    assert.ok(task)
    const marker = task.workflow?.expectedMarker || 'WF-MISSING'
    task.status = 'completed'
    task.result = `${marker}\nAccepted. Files changed: none. Verification: workflow smoke checked. Blockers: none. Decision: Pass.`
    task.updatedAt += 1
  }
  storage.saveTasks(tasks)

  const first = workflows.continueWorkflowRun(launched.payload.run.id, {
    continueUntilDone: true,
    safetyProfile: { maxIterations: 1 },
  })
  assert.equal(first.ok, true)
  if (!first.ok) return

  const second = workflows.continueWorkflowRun(launched.payload.run.id, {
    continueUntilDone: true,
    safetyProfile: { maxIterations: 1 },
  })
  assert.equal(second.ok, true)
  if (!second.ok) return

  assert.equal(second.payload.state, 'checkpoint')
  assert.equal(second.payload.nextAction, 'request_checkpoint')
  assert.match(second.payload.summary, /maxIterations/)
  assert.deepEqual(second.payload.policy?.stopReasons, ['maxIterations reached (1/1)'])
})
