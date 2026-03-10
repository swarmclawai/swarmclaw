import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-storage-items-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: path.join(tempDir, 'data'),
        WORKSPACE_DIR: path.join(tempDir, 'workspace'),
        BROWSER_PROFILES_DIR: path.join(tempDir, 'browser-profiles'),
      },
      encoding: 'utf-8',
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

test('item-level storage helpers load and patch sessions and tasks', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('./src/lib/server/storage')
    const storage = storageMod.default || storageMod['module.exports'] || storageMod

    const now = Date.now()
    storage.upsertSession('session-item', {
      id: 'session-item',
      name: 'Item Test',
      cwd: '/tmp',
      user: 'tester',
      provider: 'claude-cli',
      model: '',
      claudeSessionId: null,
      codexThreadId: null,
      opencodeSessionId: null,
      messages: [{ role: 'user', text: 'hello', time: now }],
      createdAt: now,
      lastActiveAt: now,
      sessionType: 'human',
    })

    const loadedSession = storage.loadSession('session-item')
    storage.patchSession('session-item', (current) => {
      current.messages.push({ role: 'assistant', text: 'hi', time: now + 1 })
      current.lastActiveAt = now + 1
      return current
    })
    const patchedSession = storage.loadSession('session-item')

    storage.upsertTask('task-item', {
      id: 'task-item',
      title: 'Patch me',
      status: 'queued',
      agentId: 'default',
      createdAt: now,
      updatedAt: now,
    })

    const loadedTask = storage.loadTask('task-item')
    storage.patchTask('task-item', (current) => {
      current.status = 'completed'
      current.updatedAt = now + 2
      current.result = 'done'
      return current
    })
    const patchedTask = storage.loadTask('task-item')

    console.log(JSON.stringify({
      loadedSessionCount: loadedSession?.messages?.length || 0,
      patchedSessionCount: patchedSession?.messages?.length || 0,
      patchedSessionLastText: patchedSession?.messages?.at(-1)?.text || null,
      loadedTaskStatus: loadedTask?.status || null,
      patchedTaskStatus: patchedTask?.status || null,
      patchedTaskResult: patchedTask?.result || null,
    }))
  `)

  assert.equal(output.loadedSessionCount, 1)
  assert.equal(output.patchedSessionCount, 2)
  assert.equal(output.patchedSessionLastText, 'hi')
  assert.equal(output.loadedTaskStatus, 'queued')
  assert.equal(output.patchedTaskStatus, 'completed')
  assert.equal(output.patchedTaskResult, 'done')
})

test('TTL-backed storage loaders return defensive clones on cold reads', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('./src/lib/server/storage')
    const storage = storageMod.default || storageMod['module.exports'] || storageMod

    storage.saveCredentials({
      cred_1: {
        id: 'cred_1',
        name: 'Original credential',
        encryptedKey: 'ciphertext',
      },
    })
    storage.saveGatewayProfiles({
      gateway_1: {
        id: 'gateway_1',
        name: 'Primary gateway',
        baseUrl: 'http://localhost:3456',
      },
    })
    storage.saveConnectors({
      connector_1: {
        id: 'connector_1',
        name: 'Primary connector',
        platform: 'discord',
      },
    })

    const coldCredentials = storage.loadCredentials()
    coldCredentials.cred_1.name = 'Mutated credential'

    const coldGateways = storage.loadGatewayProfiles()
    coldGateways.gateway_1.name = 'Mutated gateway'

    const coldConnectors = storage.loadConnectors()
    coldConnectors.connector_1.name = 'Mutated connector'

    const reloadedCredentials = storage.loadCredentials()
    const reloadedGateways = storage.loadGatewayProfiles()
    const reloadedConnectors = storage.loadConnectors()

    console.log(JSON.stringify({
      credentialName: reloadedCredentials.cred_1?.name || null,
      gatewayName: reloadedGateways.gateway_1?.name || null,
      connectorName: reloadedConnectors.connector_1?.name || null,
    }))
  `)

  assert.equal(output.credentialName, 'Original credential')
  assert.equal(output.gatewayName, 'Primary gateway')
  assert.equal(output.connectorName, 'Primary connector')
})

test('item-level upserts invalidate TTL-backed collection loaders', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('./src/lib/server/storage')
    const storage = storageMod.default || storageMod['module.exports'] || storageMod

    storage.saveConnectors({
      connector_1: {
        id: 'connector_1',
        name: 'Primary connector',
        platform: 'discord',
      },
    })

    const warmed = storage.loadConnectors()
    const beforeKeys = Object.keys(warmed).sort()

    storage.upsertStoredItem('connectors', 'connector_2', {
      id: 'connector_2',
      name: 'Secondary connector',
      platform: 'discord',
    })

    const afterKeys = Object.keys(storage.loadConnectors()).sort()

    console.log(JSON.stringify({
      beforeKeys,
      afterKeys,
      connector2Name: storage.loadConnectors().connector_2?.name || null,
    }))
  `)

  assert.deepEqual(output.beforeKeys, ['connector_1'])
  assert.deepEqual(output.afterKeys, ['connector_1', 'connector_2'])
  assert.equal(output.connector2Name, 'Secondary connector')
})

test('queue patching, runtime locks, and usage spend queries are transactional', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('./src/lib/server/storage')
    const storage = storageMod.default || storageMod['module.exports'] || storageMod

    const firstQueueSize = storage.patchQueue((queue) => {
      queue.push('task-a')
      queue.push('task-b')
      return queue.length
    })
    storage.patchQueue((queue) => {
      queue.splice(0, 1)
      return queue.slice()
    })

    const firstLock = storage.tryAcquireRuntimeLock('task-queue', 'owner-a', 50)
    const secondLockWhileHeld = storage.tryAcquireRuntimeLock('task-queue', 'owner-b', 50)
    const renewedOwnerA = storage.renewRuntimeLock('task-queue', 'owner-a', 50)
    let secondLockAfterExpiry = false
    const expiryDeadline = Date.now() + 1000
    while (!secondLockAfterExpiry && Date.now() < expiryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 40))
      secondLockAfterExpiry = storage.tryAcquireRuntimeLock('task-queue', 'owner-b', 50)
    }
    const renewedOwnerB = storage.renewRuntimeLock('task-queue', 'owner-b', 50)
    storage.releaseRuntimeLock('task-queue', 'owner-b')
    const thirdLockAfterRelease = storage.tryAcquireRuntimeLock('task-queue', 'owner-c', 40)

    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    const minTs = dayStart.getTime()
    storage.appendUsage('session-a', { timestamp: minTs - 1000, estimatedCost: 5 })
    storage.appendUsage('session-a', { timestamp: minTs + 1000, estimatedCost: 1.25 })
    storage.appendUsage('session-b', { timestamp: minTs + 2000, estimatedCost: 2.5 })

    console.log(JSON.stringify({
      firstQueueSize,
      queueAfterPatch: storage.loadQueue(),
      firstLock,
      secondLockWhileHeld,
      renewedOwnerA,
      secondLockAfterExpiry,
      renewedOwnerB,
      thirdLockAfterRelease,
      spendSinceDayStart: storage.getUsageSpendSince(minTs),
    }))
  `)

  assert.equal(output.firstQueueSize, 2)
  assert.deepEqual(output.queueAfterPatch, ['task-b'])
  assert.equal(output.firstLock, true)
  assert.equal(output.secondLockWhileHeld, false)
  assert.equal(output.renewedOwnerA, true)
  assert.equal(output.secondLockAfterExpiry, true)
  assert.equal(output.renewedOwnerB, true)
  assert.equal(output.thirdLockAfterRelease, true)
  assert.equal(output.spendSinceDayStart, 3.75)
})

test('row-level agent, schedule, and task helpers update one record without losing siblings', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('./src/lib/server/storage')
    const storage = storageMod.default || storageMod['module.exports'] || storageMod

    const now = Date.now()
    storage.saveAgents({
      'agent-a': { id: 'agent-a', name: 'Agent A', createdAt: now, updatedAt: now },
      'agent-b': { id: 'agent-b', name: 'Agent B', createdAt: now, updatedAt: now },
    })
    storage.saveSchedules({
      'schedule-a': { id: 'schedule-a', name: 'Schedule A', status: 'active', createdAt: now, updatedAt: now },
      'schedule-b': { id: 'schedule-b', name: 'Schedule B', status: 'paused', createdAt: now, updatedAt: now },
    })
    storage.saveTasks({
      'task-a': { id: 'task-a', title: 'Task A', status: 'backlog', agentId: 'agent-a', createdAt: now, updatedAt: now },
      'task-b': { id: 'task-b', title: 'Task B', status: 'queued', agentId: 'agent-b', createdAt: now, updatedAt: now },
    })

    // Warm the non-trashed agent cache before the upsert so the test verifies invalidation.
    storage.loadAgents()

    storage.upsertAgent('agent-a', { id: 'agent-a', name: 'Agent A Updated', createdAt: now, updatedAt: now + 1 })
    storage.upsertSchedule('schedule-a', { id: 'schedule-a', name: 'Schedule A', status: 'completed', createdAt: now, updatedAt: now + 1 })
    storage.upsertTasks([
      ['task-a', { id: 'task-a', title: 'Task A', status: 'completed', agentId: 'agent-a', createdAt: now, updatedAt: now + 1 }],
    ])

    const agents = storage.loadAgents()
    const schedules = storage.loadSchedules()
    const tasks = storage.loadTasks()

    console.log(JSON.stringify({
      agentNames: Object.keys(agents).sort().map((id) => agents[id].name),
      scheduleIds: Object.keys(schedules).sort(),
      taskIds: Object.keys(tasks).sort(),
      updatedAgentName: storage.loadAgent('agent-a')?.name || null,
      updatedScheduleStatus: storage.loadSchedule('schedule-a')?.status || null,
      updatedTaskStatus: storage.loadTask('task-a')?.status || null,
    }))
  `)

  assert.deepEqual(output.agentNames, ['Agent A Updated', 'Agent B'])
  assert.deepEqual(output.scheduleIds, ['schedule-a', 'schedule-b'])
  assert.deepEqual(output.taskIds, ['task-a', 'task-b'])
  assert.equal(output.updatedAgentName, 'Agent A Updated')
  assert.equal(output.updatedScheduleStatus, 'completed')
  assert.equal(output.updatedTaskStatus, 'completed')
})

// ---------------------------------------------------------------------------
// Reliability fix #11: requireCredentialSecret validation
// ---------------------------------------------------------------------------

test('encryptKey throws a clear message when CREDENTIAL_SECRET is unset', () => {
  // Use SWARMCLAW_BUILD_MODE=1 to skip auto-generation of CREDENTIAL_SECRET,
  // then verify encryptKey throws with a clear error message.
  const cleanEnv = { ...process.env }
  delete cleanEnv.CREDENTIAL_SECRET
  cleanEnv.SWARMCLAW_BUILD_MODE = '1'

  const tempBase = path.join(os.tmpdir(), 'swarmclaw-cred-test-' + Date.now())
  cleanEnv.DATA_DIR = path.join(tempBase, 'data')
  cleanEnv.WORKSPACE_DIR = path.join(tempBase, 'workspace')

  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    const storageMod = await import('./src/lib/server/storage')
    const storage = storageMod.default || storageMod['module.exports'] || storageMod

    try {
      storage.encryptKey('test-plaintext')
      console.log(JSON.stringify({ error: null }))
    } catch (err) {
      console.log(JSON.stringify({ error: err.message }))
    }
  `], {
    cwd: repoRoot,
    env: cleanEnv,
    encoding: 'utf-8',
  })

  const lines = (result.stdout || '').trim().split('\n').map((l: string) => l.trim()).filter(Boolean)
  const jsonLine = [...lines].reverse().find((l: string) => l.startsWith('{'))
  const output = JSON.parse(jsonLine || '{}')

  assert.ok(output.error, 'encryptKey should throw when CREDENTIAL_SECRET is unset')
  assert.match(output.error, /CREDENTIAL_SECRET/, 'Error message should mention CREDENTIAL_SECRET')

  try { fs.rmSync(tempBase, { recursive: true, force: true }) } catch { /* best-effort */ }
})
