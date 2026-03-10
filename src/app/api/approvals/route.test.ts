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

test('GET and POST /api/approvals handle human-loop approvals only', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('./src/lib/server/storage')
    const approvalsMod = await import('./src/lib/server/approvals')
    const routeMod = await import('./src/app/api/approvals/route')
    const storage = storageMod.default || storageMod
    const approvals = approvalsMod.default || approvalsMod
    const route = routeMod.default || routeMod

    const humanApproval = approvals.requestApproval({
      category: 'human_loop',
      title: 'Approve deploy',
      data: { question: 'Deploy now?' },
    })
    approvals.requestApproval({
      category: 'wallet_action',
      title: 'Legacy wallet approval',
      data: { action: 'sign_message' },
    })

    const pendingBefore = await route.GET()
    const pendingBeforeJson = await pendingBefore.json()

    const approveResponse = await route.POST(new Request('http://local/api/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: humanApproval.id, approved: true }),
    }))
    const approvePayload = await approveResponse.json()

    const pendingAfter = await route.GET()
    const pendingAfterJson = await pendingAfter.json()

    const storedApproval = storage.loadApprovals()[humanApproval.id]
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

test('POST /api/approvals rejects invalid and non-human-loop approvals', () => {
  const output = runWithTempDataDir(`
    const approvalsMod = await import('./src/lib/server/approvals')
    const routeMod = await import('./src/app/api/approvals/route')
    const approvals = approvalsMod.default || approvalsMod
    const route = routeMod.default || routeMod

    const walletApproval = approvals.requestApproval({
      category: 'wallet_action',
      title: 'Legacy wallet approval',
      data: { action: 'sign_message' },
    })

    const invalidResponse = await route.POST(new Request('http://local/api/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: walletApproval.id }),
    }))
    const invalidPayload = await invalidResponse.json()

    const wrongCategory = await route.POST(new Request('http://local/api/approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: walletApproval.id, approved: true }),
    }))
    const wrongCategoryPayload = await wrongCategory.json()

    console.log(JSON.stringify({
      invalidStatus: invalidResponse.status,
      invalidError: invalidPayload?.error || null,
      wrongCategoryStatus: wrongCategory.status,
      wrongCategoryError: wrongCategoryPayload?.error || null,
    }))
  `)

  assert.equal(output.invalidStatus, 400)
  assert.match(String(output.invalidError || ''), /id and approved required/i)
  assert.equal(output.wrongCategoryStatus, 400)
  assert.match(String(output.wrongCategoryError || ''), /human-loop/i)
})
