#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const skipNext = args.has('--skip-next')
const publishAlways = args.has('--publish')
// --skip-rebuild accepted for backwards compat; electron-builder + the
// afterPack hook (scripts/electron-after-pack.cjs) now handle native module
// ABI per-architecture so there is no pre-package rebuild step to skip.
if (args.has('--skip-rebuild')) {
  // no-op
}
const platformFlag = args.has('--mac') ? '--mac'
  : args.has('--win') ? '--win'
  : args.has('--linux') ? '--linux'
  : null
const targetArg = process.argv.slice(2).find((arg) => arg.startsWith('--targets='))
const explicitTargets = targetArg
  ? targetArg.slice('--targets='.length).split(',').map((value) => value.trim()).filter(Boolean)
  : []
const envTargets = (process.env.SWARMCLAW_ELECTRON_MAC_TARGETS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const macTargets = explicitTargets.length > 0 ? explicitTargets : envTargets

function run(cmd, cmdArgs, env = {}) {
  const status = runWithStatus(cmd, cmdArgs, env)
  if (status !== 0) process.exit(status)
}

function runWithStatus(cmd, cmdArgs, env = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    console.error(`[build-electron] ${cmd} ${cmdArgs.join(' ')} failed with status ${result.status}`)
    return result.status ?? 1
  }
  return 0
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

console.log('[build-electron] compiling electron main process…')
run('npx', ['--no-install', 'tsc', '-p', 'electron/tsconfig.json'])

if (!skipNext) {
  console.log('[build-electron] running next build…')
  run('npm', ['run', 'build'])
}

const standaloneDir = path.join(repoRoot, '.next', 'standalone')
if (!fs.existsSync(standaloneDir)) {
  console.error(`[build-electron] missing ${standaloneDir}. Did next build fail?`)
  process.exit(1)
}

console.log('[build-electron] copying static + public into standalone…')
const nextStatic = path.join(repoRoot, '.next', 'static')
const standaloneNextStatic = path.join(standaloneDir, '.next', 'static')
if (fs.existsSync(nextStatic)) {
  fs.rmSync(standaloneNextStatic, { recursive: true, force: true })
  copyDir(nextStatic, standaloneNextStatic)
}
const publicDir = path.join(repoRoot, 'public')
const standalonePublic = path.join(standaloneDir, 'public')
if (fs.existsSync(publicDir)) {
  fs.rmSync(standalonePublic, { recursive: true, force: true })
  copyDir(publicDir, standalonePublic)
}

// Native modules inside .next/standalone/node_modules are rebuilt per-arch by
// the electron-builder afterPack hook (scripts/electron-after-pack.cjs), which
// runs electron-rebuild against the packaged .app's copy of standalone/. Doing
// it here would only rebuild once for the host arch and be overwritten during
// packaging anyway.

console.log('[build-electron] running electron-builder…')
const builderArgs = []
if (platformFlag) builderArgs.push(platformFlag)
if (platformFlag === '--mac' && macTargets.length > 0) builderArgs.push(...macTargets)
if (publishAlways) {
  builderArgs.push('--publish', 'always')
} else {
  builderArgs.push('--publish', 'never')
}
const builderStatus = runWithStatus('npx', ['--no-install', 'electron-builder', ...builderArgs])
if (builderStatus !== 0) process.exit(builderStatus)

console.log('[build-electron] done. Artifacts in release/')
