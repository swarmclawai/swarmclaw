import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function extractLastJson(stdout: string): Record<string, unknown> {
  const lines = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'))
  return JSON.parse(jsonLine || '{}')
}

describe('data-dir resolution', () => {
  it('falls back to in-project workspace when the external workspace root exists but child writes fail', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-data-dir-'))
    const fakeHome = path.join(tempDir, 'home')
    const dataDir = path.join(tempDir, 'data')
    const externalWorkspace = path.join(fakeHome, '.swarmclaw', 'workspace')
    fs.mkdirSync(externalWorkspace, { recursive: true })
    fs.chmodSync(externalWorkspace, 0o555)

    try {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
        const modNs = await import('./src/lib/server/data-dir.ts')
        const mod = modNs.default || modNs['module.exports'] || modNs
        console.log(JSON.stringify({
          dataDir: mod.DATA_DIR,
          workspaceDir: mod.WORKSPACE_DIR,
        }))
      `], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HOME: fakeHome,
          DATA_DIR: dataDir,
        },
        encoding: 'utf-8',
      })

      assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
      const payload = extractLastJson(result.stdout || '')
      assert.equal(payload.dataDir, dataDir)
      assert.equal(payload.workspaceDir, path.join(dataDir, 'workspace'))
    } finally {
      fs.chmodSync(externalWorkspace, 0o755)
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
