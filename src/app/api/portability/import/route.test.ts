import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-portability-import-'))
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

test('POST /api/portability/import validates manifest arrays before importing', () => {
  const output = runWithTempDataDir(`
    const routeMod = await import('./src/app/api/portability/import/route')
    const route = routeMod.default || routeMod

    const invalidResponse = await route.POST(new Request('http://local/api/portability/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ formatVersion: 1, agents: [] }),
    }))
    const invalidPayload = await invalidResponse.json()

    const validResponse = await route.POST(new Request('http://local/api/portability/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        formatVersion: 1,
        exportedAt: '2026-03-29T00:00:00.000Z',
        agents: [],
        skills: [],
        schedules: [],
      }),
    }))
    const validPayload = await validResponse.json()

    console.log(JSON.stringify({
      invalidStatus: invalidResponse.status,
      invalidError: invalidPayload?.error || null,
      invalidPaths: Array.isArray(invalidPayload?.issues)
        ? invalidPayload.issues.map((issue) => issue.path).sort()
        : [],
      validStatus: validResponse.status,
      validAgentsCreated: validPayload?.agents?.created ?? null,
      validSkillsCreated: validPayload?.skills?.created ?? null,
      validSchedulesCreated: validPayload?.schedules?.created ?? null,
    }))
  `)

  assert.equal(output.invalidStatus, 400)
  assert.equal(output.invalidError, 'Validation failed')
  assert.deepEqual(output.invalidPaths, ['schedules', 'skills'])
  assert.equal(output.validStatus, 200)
  assert.equal(output.validAgentsCreated, 0)
  assert.equal(output.validSkillsCreated, 0)
  assert.equal(output.validSchedulesCreated, 0)
})
