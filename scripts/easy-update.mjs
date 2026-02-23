#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

const args = new Set(process.argv.slice(2))
const skipBuild = args.has('--skip-build')
const allowDirty = args.has('--allow-dirty')
const cwd = process.cwd()

function log(message) {
  process.stdout.write(`[update] ${message}\n`)
}

function fail(message, code = 1) {
  process.stderr.write(`[update] ERROR: ${message}\n`)
  process.exit(code)
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    ...options,
  })
  if (result.error) {
    return { ok: false, out: '', err: result.error.message, code: result.status ?? 1 }
  }
  if ((result.status ?? 1) !== 0) {
    const err = String(result.stderr || result.stdout || '').trim() || `exit ${result.status}`
    return { ok: false, out: '', err, code: result.status ?? 1 }
  }
  return { ok: true, out: String(result.stdout || '').trim(), err: '', code: 0 }
}

function runOrThrow(command, commandArgs, options = {}) {
  log(`$ ${command} ${commandArgs.join(' ')}`.trim())
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    ...options,
  })
  if (result.error) fail(result.error.message)
  if ((result.status ?? 1) !== 0) {
    fail(`Command failed: ${command} ${commandArgs.join(' ')}`, result.status ?? 1)
  }
}

function main() {
  const gitCheck = run('git', ['rev-parse', '--is-inside-work-tree'])
  if (!gitCheck.ok) {
    fail('This folder is not a git repository. Automatic updates require git.')
  }

  const dirty = run('git', ['status', '--porcelain'])
  const isDirty = !!dirty.out
  if (isDirty && !allowDirty) {
    const changed = dirty.out.split('\n').map((line) => line.trim()).filter(Boolean)
    const preview = changed.slice(0, 20)
    process.stdout.write(`${preview.join('\n')}\n`)
    if (changed.length > preview.length) {
      log(`...and ${changed.length - preview.length} more changed file(s).`)
    }
    fail('Local changes detected. Commit/stash them first, or rerun with --allow-dirty.')
  }

  const beforeSha = run('git', ['rev-parse', '--short', 'HEAD'])
  if (!beforeSha.ok || !beforeSha.out) {
    fail('Could not resolve current git SHA.')
  }

  runOrThrow('git', ['fetch', 'origin', 'main', '--quiet'])
  const behind = run('git', ['rev-list', 'HEAD..origin/main', '--count'])
  const behindBy = Number.parseInt(behind.out || '0', 10) || 0

  if (behindBy <= 0) {
    log('Already up to date. Nothing to install.')
    return
  }

  log(`Found ${behindBy} new commit(s). Updating now...`)
  runOrThrow('git', ['pull', '--ff-only', 'origin', 'main'])

  const changed = run('git', ['diff', '--name-only', `${beforeSha.out}..HEAD`])
  const changedFiles = new Set((changed.out || '').split('\n').map((s) => s.trim()).filter(Boolean))
  const depsChanged = changedFiles.has('package.json') || changedFiles.has('package-lock.json')

  if (depsChanged) {
    runOrThrow('npm', ['install'])
  } else {
    log('No dependency changes detected. Skipping npm install.')
  }

  if (!skipBuild) {
    runOrThrow('npm', ['run', 'build'])
  } else {
    log('Skipping build step (--skip-build).')
  }

  log('Update complete.')
  log('Restart SwarmClaw to apply the new version.')
}

main()
