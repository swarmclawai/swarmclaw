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

const PKG_ROOT = path.resolve(__dirname, '..')
const PACKAGE_NAME = '@swarmclawai/swarmclaw'
const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const PACKAGE_MANAGER = detectPackageManager(PKG_ROOT)

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

function runRegistrySelfUpdate(
  packageManager = PACKAGE_MANAGER,
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
    logger.log('Restart the server to apply changes: swarmclaw server stop && swarmclaw server start')
    return 0
  } catch (err) {
    logger.logError(`Registry update failed: ${err.message}`)
    logger.logError(`Retry manually with: ${update.display}`)
    return 1
  }
}

function main() {
  const args = process.argv.slice(3)
  if (args.includes('-h') || args.includes('--help')) {
    console.log(`
Usage: swarmclaw update

If running from a git checkout, pull the latest SwarmClaw release tag.
If running from a registry install, update the global package with ${PACKAGE_MANAGER}.
`.trim())
    process.exit(0)
  }

  // Verify we're in a git repo
  try {
    run('git rev-parse --git-dir')
  } catch {
    process.exit(runRegistrySelfUpdate(PACKAGE_MANAGER))
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

    // Check for uncommitted changes
    const dirty = run('git status --porcelain')
    if (dirty) {
      logError('Local changes detected. Commit or stash them first, then retry.')
      process.exit(1)
    }

    log(`Updating to ${latestTag}...`)
    run(`git checkout -B stable ${latestTag}^{commit}`)
    pullOutput = `Updated to stable release ${latestTag}.`
  } else {
    // Fallback: pull from origin/main
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

  // Install deps if package files changed
  try {
    const diff = run(`git diff --name-only ${beforeSha}..HEAD`)
    if (dependenciesChanged(diff)) {
      const install = getInstallCommand(PACKAGE_MANAGER, true)
      log(`Package files changed — running ${PACKAGE_MANAGER} install...`)
      execFileSync(install.command, install.args, { cwd: PKG_ROOT, stdio: 'inherit', timeout: 120_000 })
    }
  } catch {
    // If diff fails, skip install check
  }

  log(`Done (${beforeSha} → ${newSha}, channel: ${channel}).`)
  log('Restart the server to apply changes: swarmclaw server stop && swarmclaw server start')
}

if (require.main === module) {
  main()
}

module.exports = {
  main,
  runRegistrySelfUpdate,
}
