#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const cwd = process.cwd()
const args = new Set(process.argv.slice(2))
const quiet = args.has('--quiet')
const required = args.has('--required')
const image = process.env.SWARMCLAW_SANDBOX_BROWSER_IMAGE || 'swarmclaw-sandbox-browser:bookworm-slim'
const SOURCE_LABEL = 'swarmclaw.sandboxBrowserSourceHash'

function log(message) {
  if (!quiet) process.stdout.write(`[sandbox-browser] ${message}\n`)
}

function fail(message, code = 1) {
  process.stderr.write(`[sandbox-browser] ERROR: ${message}\n`)
  process.exit(code)
}

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    ...options,
  })
}

function commandExists(name) {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  const result = run(lookup, [name])
  return !result.error && (result.status ?? 1) === 0
}

function computeSourceHash() {
  const hash = crypto.createHash('sha1')
  for (const relative of ['Dockerfile.sandbox-browser', 'scripts/sandbox-browser-entrypoint.sh']) {
    const absolute = path.join(cwd, relative)
    if (!fs.existsSync(absolute)) {
      fail(`Missing sandbox browser source file: ${relative}`)
    }
    hash.update(relative)
    hash.update(fs.readFileSync(absolute))
  }
  return hash.digest('hex')
}

function readImageLabel(name, label) {
  const result = run('docker', ['image', 'inspect', '--format', `{{ index .Config.Labels "${label}" }}`, name])
  if (result.error || (result.status ?? 1) !== 0) return null
  const value = String(result.stdout || '').trim()
  return value && value !== '<no value>' ? value : null
}

function buildImage(sourceHash) {
  log(`Building sandbox browser image ${image}...`)
  const result = spawnSync(
    'docker',
    [
      'build',
      '-f', 'Dockerfile.sandbox-browser',
      '-t', image,
      '--label', `${SOURCE_LABEL}=${sourceHash}`,
      '.',
    ],
    {
      cwd,
      stdio: 'inherit',
    },
  )
  if (result.error || (result.status ?? 1) !== 0) {
    if (required) {
      fail(`Failed to build sandbox browser image ${image}.`, result.status ?? 1)
    }
    log(`Skipping sandbox browser image after build failure.`)
    return false
  }
  log(`Sandbox browser image ready: ${image}`)
  return true
}

function main() {
  if (!commandExists('docker')) {
    if (required) fail('Docker is required to build the sandbox browser image.')
    log('Docker not available. Skipping sandbox browser image build.')
    return
  }

  const sourceHash = computeSourceHash()
  const currentHash = readImageLabel(image, SOURCE_LABEL)
  if (currentHash === sourceHash) {
    log(`Sandbox browser image already current: ${image}`)
    return
  }

  buildImage(sourceHash)
}

main()
