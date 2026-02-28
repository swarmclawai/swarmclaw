#!/usr/bin/env node
'use strict'

const path = require('node:path')
const { spawnSync } = require('node:child_process')

// Route 'server' and 'update' subcommands to CJS scripts (no TS dependency)
if (process.argv[2] === 'server') {
  require('./server-cmd.js')
} else if (process.argv[2] === 'update') {
  require('./update-cmd.js')
} else {
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
}
