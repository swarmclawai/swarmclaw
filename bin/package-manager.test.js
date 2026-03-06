'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  INSTALL_METADATA_FILE,
  LOCKFILE_NAMES,
  dependenciesChanged,
  detectPackageManager,
  detectPackageManagerFromUserAgent,
  getGlobalUpdateSpec,
  getInstallCommand,
  getRunScriptCommand,
} = require('./package-manager.js')

test('detectPackageManagerFromUserAgent parses supported package managers', () => {
  assert.equal(detectPackageManagerFromUserAgent('pnpm/10.6.1 npm/? node/v22.6.0 darwin arm64'), 'pnpm')
  assert.equal(detectPackageManagerFromUserAgent('yarn/4.7.0 npm/? node/v22.6.0 darwin arm64'), 'yarn')
  assert.equal(detectPackageManagerFromUserAgent('bun/1.2.10 npm/? node/v22.6.0 darwin arm64'), 'bun')
  assert.equal(detectPackageManagerFromUserAgent('npm/10.9.2 node/v22.6.0 darwin arm64'), 'npm')
})

test('detectPackageManager prefers the lockfile present in the workspace', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-pm-'))

  fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), 'lock', 'utf8')
  assert.equal(detectPackageManager(tmpDir), 'pnpm')

  fs.writeFileSync(path.join(tmpDir, 'bun.lockb'), 'lock', 'utf8')
  assert.equal(detectPackageManager(tmpDir), 'bun')

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('detectPackageManager falls back to npm when no lockfile exists', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-pm-empty-'))
  assert.equal(detectPackageManager(tmpDir), 'npm')
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('detectPackageManager uses install metadata when present', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-pm-meta-'))
  fs.writeFileSync(
    path.join(tmpDir, INSTALL_METADATA_FILE),
    JSON.stringify({ packageManager: 'yarn' }),
    'utf8',
  )
  assert.equal(detectPackageManager(tmpDir), 'yarn')
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('dependenciesChanged recognizes package.json and all supported lockfiles', () => {
  assert.equal(dependenciesChanged('package.json\nsrc/app.ts'), true)
  for (const lockfile of LOCKFILE_NAMES) {
    assert.equal(dependenciesChanged(`${lockfile}\nREADME.md`), true)
  }
  assert.equal(dependenciesChanged('README.md\nsrc/index.ts'), false)
})

test('getInstallCommand returns manager-specific install arguments', () => {
  assert.deepEqual(getInstallCommand('npm', true), { command: 'npm', args: ['install', '--omit=dev'] })
  assert.deepEqual(getInstallCommand('pnpm', false), { command: 'pnpm', args: ['install'] })
  assert.deepEqual(getInstallCommand('yarn', true), { command: 'yarn', args: ['install', '--production=true'] })
  assert.deepEqual(getInstallCommand('bun', true), { command: 'bun', args: ['install', '--production'] })
})

test('getRunScriptCommand returns manager-specific script launchers', () => {
  assert.deepEqual(getRunScriptCommand('npm', 'build'), { command: 'npm', args: ['run', 'build'] })
  assert.deepEqual(getRunScriptCommand('pnpm', 'start'), { command: 'pnpm', args: ['start'] })
  assert.deepEqual(getRunScriptCommand('yarn', 'dev'), { command: 'yarn', args: ['dev'] })
  assert.deepEqual(getRunScriptCommand('bun', 'start'), { command: 'bun', args: ['run', 'start'] })
})

test('getGlobalUpdateSpec returns manager-specific update commands', () => {
  assert.deepEqual(getGlobalUpdateSpec('npm', '@swarmclawai/swarmclaw'), {
    command: 'npm',
    args: ['update', '-g', '@swarmclawai/swarmclaw'],
    display: 'npm update -g @swarmclawai/swarmclaw',
  })
  assert.deepEqual(getGlobalUpdateSpec('pnpm', '@swarmclawai/swarmclaw'), {
    command: 'pnpm',
    args: ['add', '-g', '@swarmclawai/swarmclaw@latest'],
    display: 'pnpm add -g @swarmclawai/swarmclaw@latest',
  })
})
