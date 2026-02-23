#!/usr/bin/env node
'use strict'

const path = require('node:path')
const { spawnSync } = require('node:child_process')

const cliPath = path.join(__dirname, '..', 'src', 'cli', 'index.ts')

const child = spawnSync(
  process.execPath,
  ['--no-warnings', '--experimental-strip-types', cliPath, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
  },
)

if (child.error) {
  process.stderr.write(`${child.error.message}\n`)
  process.exitCode = 1
} else if (typeof child.status === 'number') {
  process.exitCode = child.status
} else {
  process.exitCode = 1
}
