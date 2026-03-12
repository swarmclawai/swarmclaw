import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('postinstall', () => {
  it('skips sandbox browser setup when the helper script is missing from the install context', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-postinstall-'))
    const scriptsDir = path.join(tempDir, 'scripts')
    fs.mkdirSync(scriptsDir, { recursive: true })
    fs.copyFileSync(
      path.join(repoRoot, 'scripts', 'postinstall.mjs'),
      path.join(scriptsDir, 'postinstall.mjs'),
    )
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: '@swarmclawai/swarmclaw-postinstall-test',
        version: '0.0.0-test',
      }, null, 2),
      'utf8',
    )

    try {
      const result = spawnSync(process.execPath, ['scripts/postinstall.mjs'], {
        cwd: tempDir,
        env: {
          ...process.env,
          CI: '',
          npm_config_user_agent: 'npm/10.0.0 node/v22.0.0 darwin x64',
        },
        encoding: 'utf8',
      })

      const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`
      assert.equal(result.status, 0, combinedOutput || 'postinstall subprocess failed')
      assert.match(
        combinedOutput,
        /Sandbox browser image helper is not present in this install context\. Skipping setup\./,
      )
      assert.doesNotMatch(combinedOutput, /Cannot find module/)
      assert.doesNotMatch(combinedOutput, /sandbox browser image setup failed/i)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
