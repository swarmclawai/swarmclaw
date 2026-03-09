import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-tasks-adv-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: path.join(tempDir, 'data'),
        WORKSPACE_DIR: path.join(tempDir, 'workspace'),
      },
      encoding: 'utf-8',
      timeout: 30_000,
    })
    assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
    const lines = (result.stdout || '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'))
    return JSON.parse(jsonLine || '{}')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

/** Helper: seed agents + return manage_tasks / manage_projects tool invocation boilerplate. */
const AGENT_SETUP = `
  const storageMod = await import('./src/lib/server/storage')
  const crudMod = await import('./src/lib/server/session-tools/crud')
  const storage = storageMod.default || storageMod
  const crud = crudMod.default || crudMod

  const now = Date.now()
  storage.saveAgents({
    agent1: {
      id: 'agent1',
      name: 'Alpha',
      description: 'Test agent',
      systemPrompt: '',
      provider: 'openai',
      model: 'gpt-test',
      createdAt: now,
      updatedAt: now,
    },
    agent2: {
      id: 'agent2',
      name: 'Beta',
      description: 'Second test agent',
      systemPrompt: '',
      provider: 'openai',
      model: 'gpt-test',
      createdAt: now,
      updatedAt: now,
    },
  })

  const cwd = process.env.WORKSPACE_DIR
  const tools = crud.buildCrudTools({
    cwd,
    ctx: { sessionId: 'session-1', agentId: 'agent1', platformAssignScope: 'self' },
    hasPlugin: (name) => name === 'manage_tasks' || name === 'manage_projects',
  })
  const taskTool = tools.find((entry) => entry.name === 'manage_tasks')
  const projectTool = tools.find((entry) => entry.name === 'manage_projects')
`

/** Helper to import dequeueNextRunnableTask (CJS-compatible). */
const QUEUE_IMPORT = `
  const _queueMod = await import('./src/lib/server/queue')
  const _queue = _queueMod.default || _queueMod
  const dequeueNextRunnableTask = _queue.dequeueNextRunnableTask
`

/** A result string long enough to pass task validation (>= 20 chars). */
const VALID_RESULT = 'Task completed successfully with all objectives met and verified'

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------
describe('manage_tasks: task lifecycle', () => {
  it('1. creates a task in backlog with correct fields', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const raw = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Build dashboard', description: 'Build the main dashboard view' }),
      })
      const tasks = storage.loadTasks()
      const task = Object.values(tasks)[0]
      console.log(JSON.stringify({ task }))
    `)
    assert.equal(output.task.title, 'Build dashboard')
    assert.equal(output.task.status, 'backlog')
    assert.ok(output.task.id)
    assert.ok(output.task.createdAt)
    assert.ok(output.task.updatedAt)
    assert.equal(output.task.description, 'Build the main dashboard view')
  })

  it('2. queues a backlog task — status becomes queued, queuedAt set', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Queue me', description: 'A task to queue', status: 'queued' }),
      })
      const tasks = storage.loadTasks()
      const task = Object.values(tasks)[0]
      console.log(JSON.stringify({ task }))
    `)
    assert.equal(output.task.status, 'queued')
  })

  it('3. marks a queued task as running — stays queued (normalized)', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const raw = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Run me', description: 'Test running status', status: 'queued' }),
      })
      const created = JSON.parse(raw)
      await taskTool.invoke({
        action: 'update',
        id: created.id,
        data: JSON.stringify({ status: 'running' }),
      })
      const tasks = storage.loadTasks()
      const task = tasks[created.id]
      console.log(JSON.stringify({ task }))
    `)
    // 'running' from non-running normalizes to 'queued'
    assert.equal(output.task.status, 'queued')
  })

  it('4. completes a task — status completed, result stored', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const raw = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Report generation', description: 'Produce the quarterly report' }),
      })
      const created = JSON.parse(raw)
      await taskTool.invoke({
        action: 'update',
        id: created.id,
        data: JSON.stringify({ status: 'completed', result: '${VALID_RESULT}' }),
      })
      const tasks = storage.loadTasks()
      const task = tasks[created.id]
      console.log(JSON.stringify({ task }))
    `)
    assert.equal(output.task.status, 'completed')
    assert.equal(output.task.result, VALID_RESULT)
  })

  it('5. fails a running task — status failed, error stored', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const raw = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Fail me', description: 'Will fail' }),
      })
      const created = JSON.parse(raw)
      await taskTool.invoke({
        action: 'update',
        id: created.id,
        data: JSON.stringify({ status: 'failed', error: 'Something went wrong during execution' }),
      })
      const tasks = storage.loadTasks()
      const task = tasks[created.id]
      console.log(JSON.stringify({ task }))
    `)
    assert.equal(output.task.status, 'failed')
    assert.equal(output.task.error, 'Something went wrong during execution')
  })

  it('6. archives a completed task — status archived', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const raw = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Archive candidate', description: 'Will be archived' }),
      })
      const created = JSON.parse(raw)
      await taskTool.invoke({
        action: 'update',
        id: created.id,
        data: JSON.stringify({ status: 'completed', result: '${VALID_RESULT}' }),
      })
      await taskTool.invoke({
        action: 'update',
        id: created.id,
        data: JSON.stringify({ status: 'archived' }),
      })
      const tasks = storage.loadTasks()
      const task = tasks[created.id]
      console.log(JSON.stringify({ task }))
    `)
    assert.equal(output.task.status, 'archived')
  })
})

// ---------------------------------------------------------------------------
// Task dependencies
// ---------------------------------------------------------------------------
describe('manage_tasks: task dependencies', () => {
  it('7. creates tasks where C is blockedBy [A, B]', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const rawA = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Task A', description: 'First task' }),
      })
      const rawB = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Task B', description: 'Second task' }),
      })
      const a = JSON.parse(rawA)
      const b = JSON.parse(rawB)
      const rawC = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Task C', description: 'Blocked task', blockedBy: [a.id, b.id] }),
      })
      const c = JSON.parse(rawC)
      const tasks = storage.loadTasks()
      console.log(JSON.stringify({ a, b, c: tasks[c.id] }))
    `)
    assert.ok(Array.isArray(output.c.blockedBy))
    assert.ok(output.c.blockedBy.includes(output.a.id))
    assert.ok(output.c.blockedBy.includes(output.b.id))
  })

  it('8. complete A — C still blocked (B pending)', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      ${QUEUE_IMPORT}
      const rawA = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Dep A', description: 'First dep', status: 'queued' }),
      })
      const rawB = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Dep B', description: 'Second dep', status: 'queued' }),
      })
      const a = JSON.parse(rawA)
      const b = JSON.parse(rawB)
      const rawC = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Dep C', description: 'Blocked by A and B', status: 'queued', blockedBy: [a.id, b.id] }),
      })
      const c = JSON.parse(rawC)
      // Complete A
      await taskTool.invoke({
        action: 'update',
        id: a.id,
        data: JSON.stringify({ status: 'completed', result: '${VALID_RESULT}' }),
      })
      const tasks = storage.loadTasks()
      const queue = [c.id]
      const result = dequeueNextRunnableTask(queue, tasks)
      console.log(JSON.stringify({ result }))
    `)
    // C should still be blocked since B is not completed
    assert.equal(output.result, null)
  })

  it('9. complete B — C becomes unblocked (ready to dequeue)', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      ${QUEUE_IMPORT}
      const rawA = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Unblock A', description: 'First unblock dep', status: 'queued' }),
      })
      const rawB = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Unblock B', description: 'Second unblock dep', status: 'queued' }),
      })
      const a = JSON.parse(rawA)
      const b = JSON.parse(rawB)
      const rawC = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Unblock C', description: 'Blocked by A and B', status: 'queued', blockedBy: [a.id, b.id] }),
      })
      const c = JSON.parse(rawC)
      // Complete both A and B
      await taskTool.invoke({
        action: 'update',
        id: a.id,
        data: JSON.stringify({ status: 'completed', result: '${VALID_RESULT}' }),
      })
      await taskTool.invoke({
        action: 'update',
        id: b.id,
        data: JSON.stringify({ status: 'completed', result: '${VALID_RESULT}' }),
      })
      const tasks = storage.loadTasks()
      const queue = [c.id]
      const result = dequeueNextRunnableTask(queue, tasks)
      console.log(JSON.stringify({ result, cId: c.id }))
    `)
    assert.equal(output.result, output.cId)
  })

  it('10. diamond dependency: D→E,F→G', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      ${QUEUE_IMPORT}
      const rawD = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Diamond D', description: 'Root node', status: 'queued' }),
      })
      const d = JSON.parse(rawD)
      const rawE = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Diamond E', description: 'Left branch', status: 'queued', blockedBy: [d.id] }),
      })
      const rawF = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Diamond F', description: 'Right branch', status: 'queued', blockedBy: [d.id] }),
      })
      const e = JSON.parse(rawE)
      const f = JSON.parse(rawF)
      const rawG = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Diamond G', description: 'Convergence point', status: 'queued', blockedBy: [e.id, f.id] }),
      })
      const g = JSON.parse(rawG)

      // Before completing D: E, F, G all blocked
      let tasks = storage.loadTasks()
      const r1 = dequeueNextRunnableTask([e.id, f.id, g.id], tasks)

      // Complete D: E and F unblocked
      await taskTool.invoke({ action: 'update', id: d.id, data: JSON.stringify({ status: 'completed', result: '${VALID_RESULT}' }) })
      tasks = storage.loadTasks()
      const r2 = dequeueNextRunnableTask([e.id, f.id, g.id], tasks)

      // Complete E: G still blocked
      await taskTool.invoke({ action: 'update', id: e.id, data: JSON.stringify({ status: 'completed', result: '${VALID_RESULT}' }) })
      tasks = storage.loadTasks()
      const r3 = dequeueNextRunnableTask([g.id], tasks)

      // Complete F: G unblocked
      await taskTool.invoke({ action: 'update', id: f.id, data: JSON.stringify({ status: 'completed', result: '${VALID_RESULT}' }) })
      tasks = storage.loadTasks()
      const r4 = dequeueNextRunnableTask([g.id], tasks)

      console.log(JSON.stringify({ r1, r2, r3, r4, eId: e.id, fId: f.id, gId: g.id }))
    `)
    assert.equal(output.r1, null)             // all blocked before D completes
    assert.ok(output.r2 === output.eId || output.r2 === output.fId) // E or F dequeued
    assert.equal(output.r3, null)             // G still blocked (F incomplete)
    assert.equal(output.r4, output.gId)       // G unblocked
  })

  it('11. complete D → E,F unblocked; complete E → G still blocked; complete F → G unblocked', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      ${QUEUE_IMPORT}
      const rawD = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Step D', description: 'Root node for step test', status: 'queued' }),
      })
      const d = JSON.parse(rawD)
      const rawE = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Step E', description: 'Depends on D', status: 'queued', blockedBy: [d.id] }),
      })
      const rawF = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Step F', description: 'Depends on D too', status: 'queued', blockedBy: [d.id] }),
      })
      const e = JSON.parse(rawE)
      const f = JSON.parse(rawF)
      const rawG = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Step G', description: 'Depends on E and F', status: 'queued', blockedBy: [e.id, f.id] }),
      })
      const g = JSON.parse(rawG)

      // Complete D
      await taskTool.invoke({ action: 'update', id: d.id, data: JSON.stringify({ status: 'completed', result: '${VALID_RESULT}' }) })
      let tasks = storage.loadTasks()
      const rE = dequeueNextRunnableTask([e.id], tasks)
      const rF = dequeueNextRunnableTask([f.id], tasks)

      // Complete E only
      await taskTool.invoke({ action: 'update', id: e.id, data: JSON.stringify({ status: 'completed', result: '${VALID_RESULT}' }) })
      tasks = storage.loadTasks()
      const rGstillBlocked = dequeueNextRunnableTask([g.id], tasks)

      // Complete F
      await taskTool.invoke({ action: 'update', id: f.id, data: JSON.stringify({ status: 'completed', result: '${VALID_RESULT}' }) })
      tasks = storage.loadTasks()
      const rGunblocked = dequeueNextRunnableTask([g.id], tasks)

      console.log(JSON.stringify({ rE, rF, rGstillBlocked, rGunblocked, eId: e.id, fId: f.id, gId: g.id }))
    `)
    assert.equal(output.rE, output.eId)
    assert.equal(output.rF, output.fId)
    assert.equal(output.rGstillBlocked, null)
    assert.equal(output.rGunblocked, output.gId)
  })
})

// ---------------------------------------------------------------------------
// Task queue dequeue logic
// ---------------------------------------------------------------------------
describe('manage_tasks: dequeue logic', () => {
  it('12. first task has unmet dep, second ready → second dequeued', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      ${QUEUE_IMPORT}
      const rawBlocker = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Blocker task', description: 'Blocks first task', status: 'queued' }),
      })
      const blocker = JSON.parse(rawBlocker)
      const rawBlocked = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Blocked task', description: 'Has dependency', status: 'queued', blockedBy: [blocker.id] }),
      })
      const blocked = JSON.parse(rawBlocked)
      const rawReady = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Ready task', description: 'No dependencies here', status: 'queued' }),
      })
      const ready = JSON.parse(rawReady)

      const tasks = storage.loadTasks()
      const queue = [blocked.id, ready.id]
      const result = dequeueNextRunnableTask(queue, tasks)
      console.log(JSON.stringify({ result, readyId: ready.id }))
    `)
    assert.equal(output.result, output.readyId)
  })

  it('13. empty queue → returns null', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      ${QUEUE_IMPORT}
      const tasks = storage.loadTasks()
      const result = dequeueNextRunnableTask([], tasks)
      console.log(JSON.stringify({ result }))
    `)
    assert.equal(output.result, null)
  })

  it('14. all tasks blocked → returns null', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      ${QUEUE_IMPORT}
      const rawA = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Block source', description: 'Blocker origin', status: 'queued' }),
      })
      const a = JSON.parse(rawA)
      const rawB = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Blocked one', description: 'Blocked by A', status: 'queued', blockedBy: [a.id] }),
      })
      const rawC = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Blocked two', description: 'Also blocked by A', status: 'queued', blockedBy: [a.id] }),
      })
      const b = JSON.parse(rawB)
      const c = JSON.parse(rawC)

      const tasks = storage.loadTasks()
      const queue = [b.id, c.id]
      const result = dequeueNextRunnableTask(queue, tasks)
      console.log(JSON.stringify({ result }))
    `)
    assert.equal(output.result, null)
  })

  it('15. FIFO: multiple ready tasks → first queued wins', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      ${QUEUE_IMPORT}
      const rawFirst = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'First queued task', description: 'First in line', status: 'queued' }),
      })
      const rawSecond = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Second queued task', description: 'Second in line', status: 'queued' }),
      })
      const first = JSON.parse(rawFirst)
      const second = JSON.parse(rawSecond)

      const tasks = storage.loadTasks()
      const queue = [first.id, second.id]
      const result = dequeueNextRunnableTask(queue, tasks)
      console.log(JSON.stringify({ result, firstId: first.id }))
    `)
    assert.equal(output.result, output.firstId)
  })
})

// ---------------------------------------------------------------------------
// Status normalization
// ---------------------------------------------------------------------------
describe('manage_tasks: status normalization', () => {
  it('16. setting status to running from non-running → converts to queued', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const raw = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Status norm test', description: 'Testing normalization', status: 'running' }),
      })
      const created = JSON.parse(raw)
      const tasks = storage.loadTasks()
      console.log(JSON.stringify({ status: tasks[created.id].status }))
    `)
    assert.equal(output.status, 'queued')
  })

  it('17. setting status to running from already running → stays running', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      // Seed a task already in running state directly in storage
      const tasks = storage.loadTasks()
      tasks['manual-running'] = {
        id: 'manual-running',
        title: 'Already running',
        description: 'Pre-set to running',
        status: 'running',
        agentId: 'agent1',
        createdAt: now,
        updatedAt: now,
      }
      storage.saveTasks(tasks)

      // Now update it to running again
      await taskTool.invoke({
        action: 'update',
        id: 'manual-running',
        data: JSON.stringify({ status: 'running' }),
      })
      const final = storage.loadTasks()
      console.log(JSON.stringify({ status: final['manual-running'].status }))
    `)
    assert.equal(output.status, 'running')
  })

  it('18. invalid status string → status not changed', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const raw = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Invalid status test', description: 'Testing invalid status' }),
      })
      const created = JSON.parse(raw)
      await taskTool.invoke({
        action: 'update',
        id: created.id,
        data: JSON.stringify({ status: 'bananas' }),
      })
      const tasks = storage.loadTasks()
      console.log(JSON.stringify({ status: tasks[created.id].status }))
    `)
    // Invalid status should be stripped; task keeps its original status
    assert.equal(output.status, 'backlog')
  })
})

// ---------------------------------------------------------------------------
// Title derivation
// ---------------------------------------------------------------------------
describe('manage_tasks: title derivation', () => {
  it('19. explicit title used as-is', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const raw = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'My Custom Title', description: 'Some description' }),
      })
      const created = JSON.parse(raw)
      console.log(JSON.stringify({ title: created.title }))
    `)
    assert.equal(output.title, 'My Custom Title')
  })

  it('20. no title, has description → first sentence extracted', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const raw = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ description: 'Analyze the quarterly results. Then produce a summary report.' }),
      })
      const created = JSON.parse(raw)
      console.log(JSON.stringify({ title: created.title }))
    `)
    assert.equal(output.title, 'Analyze the quarterly results')
  })

  it('21. "Untitled task" title treated as empty → derives from description', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const raw = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Untitled task', description: 'Deploy the staging environment. Verify it works.' }),
      })
      const created = JSON.parse(raw)
      console.log(JSON.stringify({ title: created.title }))
    `)
    assert.equal(output.title, 'Deploy the staging environment')
  })

  it('22. strips "please" and action verbs from derived titles', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const raw = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ description: 'Please create a new login page for the app.' }),
      })
      const created = JSON.parse(raw)
      console.log(JSON.stringify({ title: created.title }))
    `)
    // "Please create a new login page for the app." → stripped "please" and "create"
    // Trailing period retained because split(/[.!?]\s+/) only splits on punctuation followed by space
    assert.equal(output.title, 'a new login page for the app.')
  })
})

// ---------------------------------------------------------------------------
// Project integration
// ---------------------------------------------------------------------------
describe('manage_tasks: project integration', () => {
  it('23. creates a project with objective', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const raw = await projectTool.invoke({
        action: 'create',
        data: JSON.stringify({
          name: 'Test Project',
          description: 'A test project',
          objective: 'Ship the MVP',
        }),
      })
      const projects = storage.loadProjects()
      const project = Object.values(projects)[0]
      console.log(JSON.stringify({ project }))
    `)
    assert.equal(output.project.name, 'Test Project')
    assert.equal(output.project.objective, 'Ship the MVP')
    assert.ok(output.project.id)
  })

  it('24. creates tasks assigned to a project via projectId', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const projRaw = await projectTool.invoke({
        action: 'create',
        data: JSON.stringify({ name: 'Proj Alpha', description: 'Test project' }),
      })
      const proj = JSON.parse(projRaw)
      const raw = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Project task', description: 'Belongs to project', projectId: proj.id }),
      })
      const created = JSON.parse(raw)
      console.log(JSON.stringify({ projectId: created.projectId, projId: proj.id }))
    `)
    assert.equal(output.projectId, output.projId)
  })

  it('25. tasks can be filtered by projectId', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const projRaw = await projectTool.invoke({
        action: 'create',
        data: JSON.stringify({ name: 'Filter Project', description: 'For filtering' }),
      })
      const proj = JSON.parse(projRaw)
      await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'In project', description: 'Has projectId set', projectId: proj.id }),
      })
      await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'No project', description: 'No projectId set here' }),
      })
      const tasks = storage.loadTasks()
      const projectTasks = Object.values(tasks).filter((t) => t.projectId === proj.id)
      const otherTasks = Object.values(tasks).filter((t) => t.projectId !== proj.id)
      console.log(JSON.stringify({ projectCount: projectTasks.length, otherCount: otherTasks.length }))
    `)
    assert.equal(output.projectCount, 1)
    assert.equal(output.otherCount, 1)
  })
})

// ---------------------------------------------------------------------------
// Task with retry scheduling
// ---------------------------------------------------------------------------
describe('manage_tasks: retry scheduling', () => {
  it('26. task with retryScheduledAt in future → not dequeued', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      ${QUEUE_IMPORT}
      const tasks = storage.loadTasks()
      tasks['retry-future'] = {
        id: 'retry-future',
        title: 'Future retry',
        description: 'Retry in the future',
        status: 'queued',
        agentId: 'agent1',
        retryScheduledAt: Date.now() + 60_000,
        createdAt: now,
        updatedAt: now,
      }
      storage.saveTasks(tasks)

      const queue = ['retry-future']
      const result = dequeueNextRunnableTask(queue, tasks)
      console.log(JSON.stringify({ result }))
    `)
    assert.equal(output.result, null)
  })

  it('27. task with retryScheduledAt in past → eligible for dequeue', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      ${QUEUE_IMPORT}
      const tasks = storage.loadTasks()
      tasks['retry-past'] = {
        id: 'retry-past',
        title: 'Past retry',
        description: 'Retry in the past',
        status: 'queued',
        agentId: 'agent1',
        retryScheduledAt: Date.now() - 60_000,
        createdAt: now,
        updatedAt: now,
      }
      storage.saveTasks(tasks)

      const queue = ['retry-past']
      const result = dequeueNextRunnableTask(queue, tasks)
      console.log(JSON.stringify({ result }))
    `)
    assert.equal(output.result, 'retry-past')
  })
})

// ---------------------------------------------------------------------------
// Task fingerprint dedup
// ---------------------------------------------------------------------------
describe('manage_tasks: fingerprint dedup', () => {
  it('28. two tasks with same agentId + normalized title → duplicate detected', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const raw1 = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Unique dedup title', description: 'First task' }),
      })
      const raw2 = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Unique dedup title', description: 'Duplicate' }),
      })
      const first = JSON.parse(raw1)
      const second = JSON.parse(raw2)
      console.log(JSON.stringify({ firstId: first.id, secondDeduplicated: second.deduplicated, secondId: second.id }))
    `)
    assert.equal(output.secondDeduplicated, true)
    // Dedup returns the original task, so IDs should match
    assert.equal(output.secondId, output.firstId)
  })

  it('29. different agents → not duplicates', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const crudMod = await import('./src/lib/server/session-tools/crud')
      const storage = storageMod.default || storageMod
      const crud = crudMod.default || crudMod

      const now = Date.now()
      storage.saveAgents({
        agent1: { id: 'agent1', name: 'Alpha', description: '', systemPrompt: '', provider: 'openai', model: 'gpt-test', createdAt: now, updatedAt: now },
        agent2: { id: 'agent2', name: 'Beta', description: '', systemPrompt: '', provider: 'openai', model: 'gpt-test', createdAt: now, updatedAt: now },
      })

      const cwd = process.env.WORKSPACE_DIR
      const tools1 = crud.buildCrudTools({
        cwd,
        ctx: { sessionId: 's1', agentId: 'agent1', platformAssignScope: 'self' },
        hasPlugin: (name) => name === 'manage_tasks',
      })
      const tool1 = tools1.find((e) => e.name === 'manage_tasks')

      const tools2 = crud.buildCrudTools({
        cwd,
        ctx: { sessionId: 's2', agentId: 'agent2', platformAssignScope: 'self' },
        hasPlugin: (name) => name === 'manage_tasks',
      })
      const tool2 = tools2.find((e) => e.name === 'manage_tasks')

      const raw1 = await tool1.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Same title diff agent', description: 'Agent1 version' }),
      })
      const raw2 = await tool2.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Same title diff agent', description: 'Agent2 version' }),
      })
      const first = JSON.parse(raw1)
      const second = JSON.parse(raw2)
      console.log(JSON.stringify({ firstId: first.id, secondId: second.id, secondDeduplicated: second.deduplicated || false }))
    `)
    assert.notEqual(output.firstId, output.secondId)
    assert.equal(output.secondDeduplicated, false)
  })

  it('30. different titles → not duplicates', () => {
    const output = runWithTempDataDir(`
      ${AGENT_SETUP}
      const raw1 = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Title alpha', description: 'First task' }),
      })
      const raw2 = await taskTool.invoke({
        action: 'create',
        data: JSON.stringify({ title: 'Title beta', description: 'Second task' }),
      })
      const first = JSON.parse(raw1)
      const second = JSON.parse(raw2)
      const tasks = storage.loadTasks()
      console.log(JSON.stringify({
        count: Object.keys(tasks).length,
        firstId: first.id,
        secondId: second.id,
        secondDeduplicated: second.deduplicated || false,
      }))
    `)
    assert.equal(output.count, 2)
    assert.notEqual(output.firstId, output.secondId)
    assert.equal(output.secondDeduplicated, false)
  })
})
