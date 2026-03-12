#!/usr/bin/env node
'use strict'

const { spawn } = require('node:child_process')

const {
  DATA_DIR,
  PKG_ROOT,
  SWARMCLAW_HOME,
  findStandaloneServer,
} = require('./server-cmd.js')

function printHelp() {
  const help = `
Usage: swarmclaw worker [options]

Starts a dedicated background worker process for SwarmClaw to process background
queues and tasks independently of the Next.js web application.

Options:
  -h, --help        Show this help message
`.trim()
  console.log(help)
}

function main() {
  const args = process.argv.slice(3)
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') {
      printHelp()
      process.exit(0)
    } else {
      console.error(`[swarmclaw] Unknown argument: ${arg}`)
      printHelp()
      process.exit(1)
    }
  }

  process.env.DATA_DIR = DATA_DIR
  process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES = '1'
  process.env.SWARMCLAW_WORKER_ONLY = '1'

  console.log('[swarmclaw] Starting dedicated background worker...')
  console.log(`[swarmclaw] Package root: ${PKG_ROOT}`)
  console.log(`[swarmclaw] Home: ${SWARMCLAW_HOME}`)
  console.log(`[swarmclaw] Data directory: ${DATA_DIR}`)

  const serverJs = findStandaloneServer()
  if (!serverJs) {
    console.error('[swarmclaw] Standalone server.js not found in the installed package. Try running: swarmclaw server --build')
    process.exit(1)
  }

  const child = spawn(process.execPath, [serverJs], {
    cwd: PKG_ROOT,
    env: process.env,
    stdio: 'inherit',
  })

  child.on('exit', (code) => {
    process.exit(code || 0)
  })

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => child.kill(sig))
  }
}

if (require.main === module) {
  main()
}

module.exports = { main }
