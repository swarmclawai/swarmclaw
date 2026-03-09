import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

export function runWithTempDataDir<T = any>(
  script: string,
  options: {
    prefix?: string
  } = {},
): T {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix || 'swarmclaw-test-'))
  const workspaceDir = path.join(tempDir, 'workspace')
  fs.mkdirSync(workspaceDir, { recursive: true })

  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: tempDir,
        WORKSPACE_DIR: workspaceDir,
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
    return JSON.parse(jsonLine || '{}') as T
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}
