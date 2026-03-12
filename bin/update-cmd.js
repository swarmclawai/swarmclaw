#!/usr/bin/env node
'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const { execSync, execFileSync } = require('node:child_process')
const path = require('node:path')
const {
  dependenciesChanged,
  detectPackageManager,
  getGlobalUpdateSpec,
  getInstallCommand,
} = require('./package-manager.js')
const {
  PACKAGE_NAME,
  detectGlobalInstallManagerForRoot,
  resolvePackageRoot,
} = require('./install-root.js')

const PKG_ROOT = resolvePackageRoot({
  moduleDir: __dirname,
  argv1: process.argv[1],
  cwd: process.cwd(),
})
const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const FALLBACK_PACKAGE_MANAGER = detectPackageManager(PKG_ROOT)

function run(cmd) {
  return execSync(cmd, { encoding: 'utf-8', cwd: PKG_ROOT, timeout: 60_000 }).trim()
}

function log(msg) {
  process.stdout.write(`[swarmclaw] ${msg}\n`)
}

function logError(msg) {
  process.stderr.write(`[swarmclaw] ${msg}\n`)
}

function getLatestStableTag() {
  const tags = run("git tag --list 'v*' --sort=-v:refname")
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  return tags.find((t) => RELEASE_TAG_RE.test(t)) || null
}

function resolveRegistryPackageManager(execImpl = execFileSync) {
  return detectGlobalInstallManagerForRoot(PKG_ROOT, execImpl, process.env)
    || detectPackageManager(PKG_ROOT, process.env)
    || FALLBACK_PACKAGE_MANAGER
}

function rebuildStandaloneServer(
  execImpl = execFileSync,
  logger = { log, logError },
) {
  const serverCmdPath = path.join(PKG_ROOT, 'bin', 'server-cmd.js')
  logger.log('Rebuilding the standalone server bundle...')
  try {
    execImpl(process.execPath, [serverCmdPath, '--build'], {
      cwd: PKG_ROOT,
      stdio: 'inherit',
      timeout: 10 * 60_000,
    })
    logger.log('Standalone server bundle rebuilt.')
    return 0
  } catch (err) {
    logger.logError(`Standalone rebuild failed: ${err.message}`)
    logger.logError('Retry manually with: swarmclaw server --build')
    return 1
  }
}

function runRegistrySelfUpdate(
  packageManager = resolveRegistryPackageManager(),
  execImpl = execFileSync,
  logger = { log, logError },
) {
  const update = getGlobalUpdateSpec(packageManager, PACKAGE_NAME)
  logger.log(`No git checkout detected. Updating the global ${PACKAGE_NAME} install via ${packageManager}...`)
  try {
    execImpl(update.command, update.args, {
      cwd: PKG_ROOT,
      stdio: 'inherit',
      timeout: 120_000,
    })
    logger.log(`Global update complete via ${packageManager}.`)
  } catch (err) {
    logger.logError(`Registry update failed: ${err.message}`)
    logger.logError(`Retry manually with: ${update.display}`)
    return 1
  }

  logger.log('Restart the server to apply changes: swarmclaw server stop && swarmclaw server start')
  return 0
}

function main() {
  const args = process.argv.slice(3)
  if (args.includes('-h') || args.includes('--help')) {
    console.log(`
Usage: swarmclaw update

If running from a git checkout, pull the latest SwarmClaw release tag.
If running from a registry install, update the global package with its owning package manager.
`.trim())
    process.exit(0)
  }

  try {
    run('git rev-parse --git-dir')
  } catch {
    process.exit(runRegistrySelfUpdate())
  }

  const beforeRef = run('git rev-parse HEAD')
  const beforeSha = run('git rev-parse --short HEAD')

  log('Fetching latest releases...')
  try {
    run('git fetch --tags origin --quiet')
  } catch (err) {
    logError(`Fetch failed: ${err.message}`)
    process.exit(1)
  }

  const latestTag = getLatestStableTag()
  let channel = 'main'
  let pullOutput = ''

  if (latestTag) {
    channel = 'stable'
    const targetSha = run(`git rev-parse ${latestTag}^{commit}`)
    if (targetSha === beforeRef) {
      log(`Already up to date (${latestTag}, ${beforeSha}).`)
      process.exit(0)
    }

    const dirty = run('git status --porcelain')
    if (dirty) {
      logError('Local changes detected. Commit or stash them first, then retry.')
      process.exit(1)
    }

    log(`Updating to ${latestTag}...`)
    run(`git checkout -B stable ${latestTag}^{commit}`)
    pullOutput = `Updated to stable release ${latestTag}.`
  } else {
    const behindCount = parseInt(run('git rev-list HEAD..origin/main --count'), 10) || 0
    if (behindCount === 0) {
      log(`Already up to date (${beforeSha}).`)
      process.exit(0)
    }

    const dirty = run('git status --porcelain')
    if (dirty) {
      logError('Local changes detected. Commit or stash them first, then retry.')
      process.exit(1)
    }

    log(`Pulling ${behindCount} commit(s) from origin/main...`)
    pullOutput = run('git pull --ff-only origin main')
  }

  const newSha = run('git rev-parse --short HEAD')
  log(pullOutput)

  try {
    const diff = run(`git diff --name-only ${beforeSha}..HEAD`)
    if (dependenciesChanged(diff)) {
      const packageManager = detectPackageManager(PKG_ROOT, process.env)
      const install = getInstallCommand(packageManager, true)
      log(`Package files changed — running ${packageManager} install...`)
      execFileSync(install.command, install.args, { cwd: PKG_ROOT, stdio: 'inherit', timeout: 120_000 })
    }
  } catch {
    // If diff fails, skip install check.
  }

  const rebuildExitCode = rebuildStandaloneServer()
  if (rebuildExitCode !== 0) {
    process.exit(rebuildExitCode)
  }

  log(`Done (${beforeSha} → ${newSha}, channel: ${channel}).`)
  log('Restart the server to apply changes: swarmclaw server stop && swarmclaw server start')
}

if (require.main === module) {
  main()
}

module.exports = {
  main,
  rebuildStandaloneServer,
  resolveRegistryPackageManager,
  runRegistrySelfUpdate,
}
