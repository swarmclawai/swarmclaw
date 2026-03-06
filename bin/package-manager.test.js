'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  LOCKFILE_NAMES,
  dependenciesChanged,
  detectPackageManager,
  getInstallCommand,
  getRunScriptCommand,
} = require('./package-manager.js')

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
