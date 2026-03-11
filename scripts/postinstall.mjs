#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const INSTALL_METADATA_FILE = '.swarmclaw-install.json'
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '..')
const ensureSandboxBrowserScript = path.join(packageRoot, 'scripts', 'ensure-sandbox-browser-image.mjs')

function detectPackageManagerFromUserAgent(userAgent) {
  const normalized = String(userAgent || '').toLowerCase()
  if (normalized.startsWith('pnpm/')) return 'pnpm'
  if (normalized.startsWith('yarn/')) return 'yarn'
  if (normalized.startsWith('bun/')) return 'bun'
  if (normalized.startsWith('npm/')) return 'npm'
  return null
}

const installedWith = detectPackageManagerFromUserAgent(process.env.npm_config_user_agent) || 'npm'

function logNote(message) {
  process.stdout.write(`[postinstall] ${message}\n`)
}

function logWarn(message) {
  process.stderr.write(`[postinstall] WARN: ${message}\n`)
}

function commandExists(name) {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(lookup, [name], {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  return !result.error && (result.status ?? 1) === 0
}

function formatFailure(result) {
  const detail = [
    result.error?.message,
    String(result.stderr || '').trim(),
    String(result.stdout || '').trim(),
  ].find(Boolean)
  return detail || `exit ${result.status ?? 1}`
}

try {
  writeFileSync(
    new URL(`../${INSTALL_METADATA_FILE}`, import.meta.url),
    JSON.stringify({
      packageManager: installedWith,
      installedAt: new Date().toISOString(),
    }, null, 2),
    'utf8',
  )
} catch {
  // Ignore metadata write failures for install resilience.
}

const result = spawnSync('npm', ['rebuild', 'better-sqlite3', '--silent'], {
  cwd: packageRoot,
  encoding: 'utf8',
  stdio: 'pipe',
})

if (result.error || (result.status ?? 0) !== 0) {
  logWarn(`better-sqlite3 rebuild failed: ${formatFailure(result)}`)
  logWarn('Retry manually with: npm rebuild better-sqlite3')
}

if (!process.env.CI) {
  const sandboxImage = spawnSync(process.execPath, [ensureSandboxBrowserScript, '--quiet'], {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  if (sandboxImage.error || (sandboxImage.status ?? 0) !== 0) {
    logWarn(`sandbox browser image setup failed: ${formatFailure(sandboxImage)}`)
    logWarn('Retry manually with: node ./scripts/ensure-sandbox-browser-image.mjs')
  }

  if (!commandExists('docker')) {
    logNote('Docker was not found. Container sandboxes will fall back to host execution until Docker is installed.')
  }
}

if (!process.env.CI) {
  process.stdout.write('\n')
  process.stdout.write('Thanks for installing SwarmClaw.\n')
  process.stdout.write('If it helps you, please star the repo: https://github.com/swarmclawai/swarmclaw\n')
  process.stdout.write('\n')
}
