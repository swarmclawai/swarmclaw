#!/usr/bin/env node

import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import packageManager from '../bin/package-manager.js'

const { detectPackageManagerFromUserAgent, INSTALL_METADATA_FILE } = packageManager

const installedWith = detectPackageManagerFromUserAgent(process.env.npm_config_user_agent) || 'npm'

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
  stdio: 'ignore',
})

if (result.error) {
  // Ignore optional native rebuild failures for install resilience.
}

if (!process.env.CI) {
  process.stdout.write('\n')
  process.stdout.write('Thanks for installing SwarmClaw.\n')
  process.stdout.write('If it helps you, please star the repo: https://github.com/swarmclawai/swarmclaw\n')
  process.stdout.write('\n')
}
