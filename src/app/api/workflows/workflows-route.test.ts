import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-workflows-route-'))
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

test('workflow API drafts without tasks, launches a bundle, and returns a ledger', async () => {
  const storage = await seedWorkflowAgents()
  const plansRoute = await import('@/app/api/workflows/plans/route')
  const bundlesRoute = await import('@/app/api/workflows/bundles/route')
  const ledgerRoute = await import('@/app/api/workflows/runs/[id]/ledger/route')
  const continueRoute = await import('@/app/api/workflows/runs/[id]/continue/route')

  const planResponse = await plansRoute.POST(new Request('http://local/api/workflows/plans', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Route workflow',
      goal: 'Review the repo safely.',
      loopSpec: {
        invariant: 'Route test invariant stays visible.',
        progressSignal: 'Route test progress is marker evidence.',
        stuckSignal: 'Route test stops on missing markers.',
      },
    }),
  }))
  const plan = await planResponse.json()
  const taskCountAfterPlan = Object.keys(storage.loadTasks()).length
  const bundleResponse = await bundlesRoute.POST(new Request('http://local/api/workflows/bundles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(plan.bundle),
  }))
  const bundle = await bundleResponse.json()
  const ledgerResponse = await ledgerRoute.GET(new Request(`http://local/api/workflows/runs/${bundle.run.id}/ledger`), {
    params: Promise.resolve({ id: bundle.run.id }),
  })
  const ledger = await ledgerResponse.json()
  const firstTask = storage.loadTasks()[bundle.taskIds[0]]
  const tasks = storage.loadTasks()
  for (const taskId of bundle.taskIds) {
    const task = tasks[taskId]
    assert.ok(task)
    const marker = task.workflow?.expectedMarker || 'WF-MISSING'
    task.status = 'completed'
    task.result = `${marker}\nAccepted. Files changed: none. Verification: route workflow checked. Blockers: none. Decision: Pass.`
    task.updatedAt += 1
  }
  storage.saveTasks(tasks)

  const continueResponse = await continueRoute.POST(new Request(`http://local/api/workflows/runs/${bundle.run.id}/continue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      continueUntilDone: true,
      goal: 'Continue the route workflow safely.',
      loopSpec: {
        ...ledger.loopSpec,
        continuationPolicy: 'draft_only',
      },
    }),
  }), {
    params: Promise.resolve({ id: bundle.run.id }),
  })
  const continuation = await continueResponse.json()

  assert.equal(planResponse.status, 200)
  assert.equal(taskCountAfterPlan, 0)
  assert.equal(plan.createsTasks, false)
  assert.equal(plan.approvalGate.status, 'review_required')
  assert.equal(plan.bundle.queueImmediately, false)
  assert.equal(plan.bundle.loopSpec.invariant, 'Route test invariant stays visible.')
  assert.equal(bundleResponse.status, 200)
  assert.equal(ledgerResponse.status, 200)
  assert.equal(ledger.entries.length, 3)
  assert.equal(ledger.loopSpec.invariant, 'Route test invariant stays visible.')
  assert.equal(firstTask.status, 'backlog')
  assert.equal(continueResponse.status, 200)
  assert.equal(continuation.state, 'checkpoint')
  assert.equal(continuation.policy.loopSpec.invariant, 'Route test invariant stays visible.')
  assert.equal(continuation.draft.bundle.loopSpec.invariant, 'Route test invariant stays visible.')
})
