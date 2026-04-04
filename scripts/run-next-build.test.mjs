import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'

import { BUILD_BOOTSTRAP_ROOT_NAME } from './build-bootstrap-env.mjs'
import {
  DEFAULT_MAX_OLD_SPACE_SIZE_MB,
  buildNextBuildEnv,
  hasTraceCopyWarning,
  mergeNodeOptions,
} from './run-next-build.mjs'

describe('run-next-build', () => {
  it('adds a default heap limit when NODE_OPTIONS is empty', () => {
    assert.equal(
      mergeNodeOptions(''),
      `--max-old-space-size=${DEFAULT_MAX_OLD_SPACE_SIZE_MB}`,
    )
  })

  it('appends the default heap limit to unrelated NODE_OPTIONS flags', () => {
    assert.equal(
      mergeNodeOptions('--trace-warnings'),
      `--trace-warnings --max-old-space-size=${DEFAULT_MAX_OLD_SPACE_SIZE_MB}`,
    )
  })

  it('preserves an explicit heap limit', () => {
    assert.equal(
      mergeNodeOptions('--trace-warnings --max-old-space-size=4096'),
      '--trace-warnings --max-old-space-size=4096',
    )
  })

  it('buildNextBuildEnv keeps other environment variables intact', () => {
    const env = buildNextBuildEnv({ FOO: 'bar', NODE_OPTIONS: '' })
    assert.equal(env.FOO, 'bar')
    assert.equal(env.NODE_OPTIONS, `--max-old-space-size=${DEFAULT_MAX_OLD_SPACE_SIZE_MB}`)
    assert.equal(env.SWARMCLAW_BUILD_MODE, '1')
    assert.equal(env.DATA_DIR?.endsWith(path.join(BUILD_BOOTSTRAP_ROOT_NAME, 'data')), true)
    assert.equal(env.WORKSPACE_DIR?.endsWith(path.join(BUILD_BOOTSTRAP_ROOT_NAME, 'workspace')), true)
    assert.equal(
      env.BROWSER_PROFILES_DIR?.endsWith(path.join(BUILD_BOOTSTRAP_ROOT_NAME, 'browser-profiles')),
      true,
    )
  })

  it('buildNextBuildEnv preserves an explicit build mode', () => {
    const env = buildNextBuildEnv({ SWARMCLAW_BUILD_MODE: 'custom', NODE_OPTIONS: '' })
    assert.equal(env.SWARMCLAW_BUILD_MODE, 'custom')
  })

  it('detects standalone trace copy warnings in build output', () => {
    assert.equal(hasTraceCopyWarning('all good'), false)
    assert.equal(
      hasTraceCopyWarning('Warning: Failed to copy traced files for /tmp/app.js'),
      true,
    )
  })
})
