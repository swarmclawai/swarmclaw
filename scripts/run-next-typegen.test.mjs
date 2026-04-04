import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { BUILD_BOOTSTRAP_ROOT_NAME } from './build-bootstrap-env.mjs'
import {
  TYPEGEN_ARTIFACT_PATHS,
  buildNextTypegenEnv,
  cleanupTypegenArtifacts,
} from './run-next-typegen.mjs'

describe('run-next-typegen', () => {
  it('forces build mode for deterministic type generation', () => {
    const env = buildNextTypegenEnv({ FOO: 'bar' })
    assert.equal(env.FOO, 'bar')
    assert.equal(env.SWARMCLAW_BUILD_MODE, '1')
    assert.equal(env.DATA_DIR?.endsWith(path.join(BUILD_BOOTSTRAP_ROOT_NAME, 'data')), true)
    assert.equal(env.WORKSPACE_DIR?.endsWith(path.join(BUILD_BOOTSTRAP_ROOT_NAME, 'workspace')), true)
    assert.equal(
      env.BROWSER_PROFILES_DIR?.endsWith(path.join(BUILD_BOOTSTRAP_ROOT_NAME, 'browser-profiles')),
      true,
    )
  })

  it('preserves an explicit SWARMCLAW_BUILD_MODE value', () => {
    const env = buildNextTypegenEnv({ SWARMCLAW_BUILD_MODE: 'custom' })
    assert.equal(env.SWARMCLAW_BUILD_MODE, 'custom')
  })

  it('removes stale typegen artifacts before running next typegen', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-typegen-'))
    try {
      for (const relativePath of TYPEGEN_ARTIFACT_PATHS) {
        const absolutePath = path.join(tempDir, relativePath)
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
        if (relativePath.endsWith('.tsbuildinfo')) {
          fs.writeFileSync(absolutePath, 'stale')
        } else {
          fs.mkdirSync(absolutePath, { recursive: true })
          fs.writeFileSync(path.join(absolutePath, 'stale.ts'), 'export {}')
        }
      }

      cleanupTypegenArtifacts(tempDir)

      for (const relativePath of TYPEGEN_ARTIFACT_PATHS) {
        assert.equal(fs.existsSync(path.join(tempDir, relativePath)), false)
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
