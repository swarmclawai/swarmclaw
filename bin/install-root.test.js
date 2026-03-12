'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  candidateDirsFromArgv1,
  detectGlobalInstallManagerForRoot,
  resolvePackageRoot,
} = require('./install-root.js')

test('candidateDirsFromArgv1 includes the package directory for node_modules/.bin launchers', () => {
  const launcher = path.join('/tmp', 'example', 'node_modules', '.bin', 'swarmclaw')
  const candidates = candidateDirsFromArgv1(launcher)
  assert.deepEqual(candidates, [
    path.join('/tmp', 'example', 'node_modules', '.bin'),
    path.join('/tmp', 'example', 'node_modules', 'swarmclaw'),
  ])
})

test('resolvePackageRoot finds the package root from argv1 candidates', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-install-root-'))
  const pkgRoot = path.join(rootDir, 'node_modules', '@swarmclawai', 'swarmclaw')
  const binPath = path.join(rootDir, 'node_modules', '.bin', 'swarmclaw')
  const actualBin = path.join(pkgRoot, 'bin', 'swarmclaw.js')

  fs.mkdirSync(path.join(pkgRoot, 'bin'), { recursive: true })
  fs.mkdirSync(path.dirname(binPath), { recursive: true })
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: '@swarmclawai/swarmclaw' }), 'utf8')
  fs.writeFileSync(actualBin, '#!/usr/bin/env node\n', 'utf8')
  fs.symlinkSync(actualBin, binPath)

  assert.equal(resolvePackageRoot({ argv1: binPath, cwd: rootDir }), fs.realpathSync(pkgRoot))

  fs.rmSync(rootDir, { recursive: true, force: true })
})

test('detectGlobalInstallManagerForRoot matches the owning global root by realpath', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-global-root-'))
  const npmGlobalRoot = path.join(rootDir, 'npm-global')
  const pnpmGlobalRoot = path.join(rootDir, 'pnpm-global')
  const pkgRoot = path.join(pnpmGlobalRoot, '@swarmclawai', 'swarmclaw')

  fs.mkdirSync(path.join(npmGlobalRoot, '@swarmclawai'), { recursive: true })
  fs.mkdirSync(path.join(pnpmGlobalRoot, '@swarmclawai'), { recursive: true })
  fs.mkdirSync(pkgRoot, { recursive: true })

  const execImpl = (command, args) => {
    if (command === 'npm' && args.join(' ') === 'root -g') return npmGlobalRoot
    if (command === 'pnpm' && args.join(' ') === 'root -g') return pnpmGlobalRoot
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }

  assert.equal(detectGlobalInstallManagerForRoot(pkgRoot, execImpl), 'pnpm')

  fs.rmSync(rootDir, { recursive: true, force: true })
})
