#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const PACKAGE_NAME = '@swarmclawai/swarmclaw'
const CORE_PACKAGE_NAMES = new Set([PACKAGE_NAME])

function normalizeDir(value) {
  if (!value) return null
  const trimmed = String(value).trim()
  if (!trimmed) return null
  return path.resolve(trimmed)
}

function readPackageJson(rootDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

function readPackageName(rootDir) {
  return readPackageJson(rootDir)?.name?.trim() || null
}

function readPackageVersion(rootDir) {
  const version = readPackageJson(rootDir)?.version
  return typeof version === 'string' && version.trim() ? version.trim() : null
}

function* iterAncestorDirs(startDir, maxDepth = 12) {
  let current = path.resolve(startDir)
  for (let i = 0; i < maxDepth; i += 1) {
    yield current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

function findPackageRoot(startDir, maxDepth = 12) {
  for (const current of iterAncestorDirs(startDir, maxDepth)) {
    const name = readPackageName(current)
    if (name && CORE_PACKAGE_NAMES.has(name)) return current
  }
  return null
}

function candidateDirsFromArgv1(argv1) {
  const normalized = normalizeDir(argv1)
  if (!normalized) return []

  const candidates = [path.dirname(normalized)]
  try {
    const resolved = fs.realpathSync(normalized)
    if (resolved !== normalized) candidates.push(path.dirname(resolved))
  } catch {}

  const parts = normalized.split(path.sep)
  const binIndex = parts.lastIndexOf('.bin')
  if (binIndex > 0 && parts[binIndex - 1] === 'node_modules') {
    const binName = path.basename(normalized)
    const nodeModulesDir = parts.slice(0, binIndex).join(path.sep)
    candidates.push(path.join(nodeModulesDir, binName))
  }

  return candidates
}

function resolvePackageRoot(opts = {}) {
  const candidates = []
  const moduleDir = normalizeDir(opts.moduleDir)
  if (moduleDir) candidates.push(moduleDir)
  const argv1 = opts.argv1 === undefined ? process.argv[1] : opts.argv1
  candidates.push(...candidateDirsFromArgv1(argv1))
  const cwd = opts.cwd === undefined ? process.cwd() : opts.cwd
  if (normalizeDir(cwd)) candidates.push(path.resolve(cwd))

  for (const candidate of candidates) {
    const found = findPackageRoot(candidate)
    if (found) return found
  }

  return moduleDir ? path.resolve(moduleDir, '..') : null
}

function tryRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath)
  } catch {
    return path.resolve(targetPath)
  }
}

function runRootCommand(command, args, execImpl = execFileSync) {
  try {
    return String(execImpl(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })).trim()
  } catch {
    return null
  }
}

function resolveGlobalRoot(manager, execImpl = execFileSync, env = process.env) {
  if (manager === 'bun') {
    const bunInstall = String(env.BUN_INSTALL || '').trim() || path.join(os.homedir(), '.bun')
    return path.join(bunInstall, 'install', 'global', 'node_modules')
  }

  if (manager === 'pnpm') {
    return runRootCommand('pnpm', ['root', '-g'], execImpl)
  }

  return runRootCommand('npm', ['root', '-g'], execImpl)
}

function detectGlobalInstallManagerForRoot(pkgRoot, execImpl = execFileSync, env = process.env) {
  const pkgReal = tryRealpath(pkgRoot)

  for (const manager of ['npm', 'pnpm']) {
    const globalRoot = resolveGlobalRoot(manager, execImpl, env)
    if (!globalRoot) continue

    for (const name of CORE_PACKAGE_NAMES) {
      const expectedReal = tryRealpath(path.join(globalRoot, name))
      if (path.resolve(expectedReal) === path.resolve(pkgReal)) return manager
    }
  }

  const bunRoot = resolveGlobalRoot('bun', execImpl, env)
  for (const name of CORE_PACKAGE_NAMES) {
    const expectedReal = tryRealpath(path.join(bunRoot, name))
    if (path.resolve(expectedReal) === path.resolve(pkgReal)) return 'bun'
  }

  return null
}

module.exports = {
  PACKAGE_NAME,
  candidateDirsFromArgv1,
  detectGlobalInstallManagerForRoot,
  findPackageRoot,
  readPackageName,
  readPackageVersion,
  resolveGlobalRoot,
  resolvePackageRoot,
}
