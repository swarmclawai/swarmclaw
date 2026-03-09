import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-approvals-route-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: path.join(tempDir, 'data'),
        WORKSPACE_DIR: path.join(tempDir, 'workspace'),
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

test('GET and POST /api/approvals smoke the pending approval flow end-to-end', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('./src/lib/server/storage')
    const approvalsMod = await import('./src/lib/server/approvals')
    const routeMod = await import('./src/app/api/approvals/route')
    const storage = storageMod.default || storageMod
    const approvals = approvalsMod.default || approvalsMod
    const route = routeMod.default || routeMod

    const now = Date.now()
    storage.saveSettings({
      approvalsEnabled: true,
      approvalAutoApproveCategories: [],
    })

    const approval = await approvals.requestApprovalMaybeAutoApprove({
      category: 'tool_access',
      title: 'Enable Plugin: shell',
      description: 'Need shell access for a smoke test.',
      data: { toolId: 'shell', pluginId: 'shell' },
    })

    const pendingBefore = await route.GET()
    const pendingBeforeJson = await pendingBefore.json()

    const approveResponse = await route.POST(new Request('http://local/api/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: approval.id, approved: true }),
    }))
    const approvePayload = await approveResponse.json()

    const pendingAfter = await route.GET()
    const pendingAfterJson = await pendingAfter.json()

    const storedApproval = storage.loadApprovals()[approval.id]
    console.log(JSON.stringify({
      pendingBeforeCount: Array.isArray(pendingBeforeJson) ? pendingBeforeJson.length : -1,
      pendingBeforeId: Array.isArray(pendingBeforeJson) ? pendingBeforeJson[0]?.id || null : null,
      approveStatus: approveResponse.status,
      approvePayload,
      pendingAfterCount: Array.isArray(pendingAfterJson) ? pendingAfterJson.length : -1,
      storedStatus: storedApproval?.status || null,
    }))
  `)

  assert.equal(output.pendingBeforeCount, 1)
  assert.notEqual(output.pendingBeforeId, null)
  assert.equal(output.approveStatus, 200)
  assert.equal(output.approvePayload?.ok, true)
  assert.equal(output.pendingAfterCount, 0)
  assert.equal(output.storedStatus, 'approved')
})

test('POST /api/approvals rejects invalid payloads and remains idempotent for repeated decisions', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('./src/lib/server/storage')
    const approvalsMod = await import('./src/lib/server/approvals')
    const routeMod = await import('./src/app/api/approvals/route')
    const storage = storageMod.default || storageMod
    const approvals = approvalsMod.default || approvalsMod
    const route = routeMod.default || routeMod

    const now = Date.now()
    storage.saveSettings({
      approvalsEnabled: true,
      approvalAutoApproveCategories: [],
    })

    const approval = await approvals.requestApprovalMaybeAutoApprove({
      category: 'tool_access',
      title: 'Enable Plugin: shell',
      description: 'Need shell access for idempotency test.',
      data: { toolId: 'shell', pluginId: 'shell' },
    })

    const invalidResponse = await route.POST(new Request('http://local/api/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: approval.id }),
    }))
    const invalidPayload = await invalidResponse.json()

    const firstApprove = await route.POST(new Request('http://local/api/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: approval.id, approved: true }),
    }))
    const secondApprove = await route.POST(new Request('http://local/api/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: approval.id, approved: true }),
    }))

    const pending = await route.GET()
    const pendingJson = await pending.json()
    const storedApproval = storage.loadApprovals()[approval.id]
    console.log(JSON.stringify({
      invalidStatus: invalidResponse.status,
      invalidError: invalidPayload?.error || null,
      firstApproveStatus: firstApprove.status,
      secondApproveStatus: secondApprove.status,
      pendingCount: Array.isArray(pendingJson) ? pendingJson.length : -1,
      storedStatus: storedApproval?.status || null,
    }))
  `)

  assert.equal(output.invalidStatus, 400)
  assert.match(String(output.invalidError || ''), /id and approved required/i)
  assert.equal(output.firstApproveStatus, 200)
  assert.equal(output.secondApproveStatus, 200)
  assert.equal(output.pendingCount, 0)
  assert.equal(output.storedStatus, 'approved')
})
