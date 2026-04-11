import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import { BUILD_BOOTSTRAP_ROOT_NAME } from './build-bootstrap-env.mjs'
import {
  BUILD_MAX_OLD_SPACE_SIZE_ENV,
  DEFAULT_MAX_OLD_SPACE_SIZE_MB,
  NEXT_STANDALONE_METADATA_RELATIVE_DIR,
  REQUIRED_NEXT_METADATA_FILES,
  buildNextBuildEnv,
  deriveMaxOldSpaceSizeMb,
  hasTraceCopyWarning,
  mergeNodeOptions,
  readCgroupMemoryLimitBytes,
  repairStandaloneNextMetadata,
  resolveNextBuildMaxOldSpaceSizeMb,
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

  it('derives a lower heap cap for constrained Docker-style memory limits', () => {
    assert.equal(
      deriveMaxOldSpaceSizeMb(4 * 1024 * 1024 * 1024),
      '3072',
    )
    assert.equal(
      deriveMaxOldSpaceSizeMb(2 * 1024 * 1024 * 1024),
      '1280',
    )
  })

  it('reads cgroup memory limits and skips unbounded sentinels', () => {
    const files = new Map([
      ['/sys/fs/cgroup/memory.max', `${4n * 1024n * 1024n * 1024n}`],
    ])
    const existsSync = (filePath) => files.has(filePath)
    const readFileSync = (filePath) => files.get(filePath)

    assert.equal(
      readCgroupMemoryLimitBytes(undefined, existsSync, readFileSync),
      4 * 1024 * 1024 * 1024,
    )

    files.set('/sys/fs/cgroup/memory.max', `${(1n << 60n) + 1n}`)
    assert.equal(
      readCgroupMemoryLimitBytes(undefined, existsSync, readFileSync),
      null,
    )
  })

  it('prefers an explicit build heap override', () => {
    assert.equal(
      resolveNextBuildMaxOldSpaceSizeMb({ [BUILD_MAX_OLD_SPACE_SIZE_ENV]: '2048' }),
      '2048',
    )
  })

  it('falls back to detected memory when no build heap override is set', () => {
    assert.equal(
      resolveNextBuildMaxOldSpaceSizeMb(
        {},
        {
          readCgroupMemoryLimitBytes: () => 4 * 1024 * 1024 * 1024,
          totalMem: () => 16 * 1024 * 1024 * 1024,
        },
      ),
      '3072',
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

  it('repairStandaloneNextMetadata copies required Next metadata files into standalone output', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-next-build-'))
    try {
      const sourceDir = path.join(tempDir, 'node_modules', 'next', 'dist', 'lib', 'metadata')
      fs.mkdirSync(path.join(tempDir, '.next', 'standalone'), { recursive: true })
      fs.mkdirSync(sourceDir, { recursive: true })
      for (const fileName of REQUIRED_NEXT_METADATA_FILES) {
        fs.writeFileSync(path.join(sourceDir, fileName), `export const fileName = '${fileName}'\n`)
      }

      const repaired = repairStandaloneNextMetadata(tempDir)
      assert.equal(repaired, true)

      const targetDir = path.join(tempDir, '.next', 'standalone', NEXT_STANDALONE_METADATA_RELATIVE_DIR)
      for (const fileName of REQUIRED_NEXT_METADATA_FILES) {
        assert.equal(fs.existsSync(path.join(targetDir, fileName)), true)
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('repairStandaloneNextMetadata is a no-op when standalone metadata files already exist', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-next-build-'))
    try {
      const sourceDir = path.join(tempDir, 'node_modules', 'next', 'dist', 'lib', 'metadata')
      const targetDir = path.join(tempDir, '.next', 'standalone', NEXT_STANDALONE_METADATA_RELATIVE_DIR)
      fs.mkdirSync(sourceDir, { recursive: true })
      fs.mkdirSync(targetDir, { recursive: true })
      for (const fileName of REQUIRED_NEXT_METADATA_FILES) {
        fs.writeFileSync(path.join(sourceDir, fileName), `source:${fileName}\n`)
        fs.writeFileSync(path.join(targetDir, fileName), `target:${fileName}\n`)
      }

      const repaired = repairStandaloneNextMetadata(tempDir)
      assert.equal(repaired, false)

      for (const fileName of REQUIRED_NEXT_METADATA_FILES) {
        assert.equal(fs.readFileSync(path.join(targetDir, fileName), 'utf8'), `target:${fileName}\n`)
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('repairStandaloneNextMetadata fails fast when the installed Next package is missing required files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-next-build-'))
    try {
      fs.mkdirSync(path.join(tempDir, '.next', 'standalone'), { recursive: true })
      const sourceDir = path.join(tempDir, 'node_modules', 'next', 'dist', 'lib', 'metadata')
      fs.mkdirSync(sourceDir, { recursive: true })
      fs.writeFileSync(path.join(sourceDir, REQUIRED_NEXT_METADATA_FILES[0]), 'export {}\n')

      assert.throws(
        () => repairStandaloneNextMetadata(tempDir),
        /Missing required Next metadata runtime files/,
      )
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
