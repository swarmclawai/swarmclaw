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
  findLocalInstallProjectRoot,
  resolvePackageRoot,
  resolveStateHome,
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

test('findLocalInstallProjectRoot returns the project root for nested pnpm installs', () => {
  const pkgRoot = path.join(
    '/tmp',
    'example',
    'node_modules',
    '.pnpm',
    '@swarmclawai+swarmclaw@1.0.1',
    'node_modules',
    '@swarmclawai',
    'swarmclaw',
  )

  assert.equal(findLocalInstallProjectRoot(pkgRoot), path.join('/tmp', 'example'))
})

test('resolveStateHome prefers the local project .swarmclaw directory for local installs', () => {
  const projectRoot = path.join('/tmp', 'example')
  const pkgRoot = path.join(projectRoot, 'node_modules', '@swarmclawai', 'swarmclaw')
  const execImpl = () => {
    throw new Error('unexpected global root lookup')
  }

  assert.equal(
    resolveStateHome({
      pkgRoot,
      env: {},
      execImpl,
    }),
    path.join(projectRoot, '.swarmclaw'),
  )
})

test('resolveStateHome keeps global installs under the user home directory', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-state-home-'))
  const npmGlobalRoot = path.join(rootDir, 'npm-global')
  const pkgRoot = path.join(npmGlobalRoot, '@swarmclawai', 'swarmclaw')

  fs.mkdirSync(path.join(npmGlobalRoot, '@swarmclawai'), { recursive: true })
  fs.mkdirSync(pkgRoot, { recursive: true })

  const execImpl = (command, args) => {
    if (command === 'npm' && args.join(' ') === 'root -g') return npmGlobalRoot
    if (command === 'pnpm' && args.join(' ') === 'root -g') return path.join(rootDir, 'pnpm-global')
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
  }

  assert.equal(
    resolveStateHome({
      pkgRoot,
      env: {},
      execImpl,
    }),
    path.join(os.homedir(), '.swarmclaw'),
  )

  fs.rmSync(rootDir, { recursive: true, force: true })
})
