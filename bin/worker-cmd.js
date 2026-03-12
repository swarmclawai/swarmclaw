#!/usr/bin/env node
'use strict'

const { spawn } = require('node:child_process')

const {
  BROWSER_PROFILES_DIR,
  DATA_DIR,
  PKG_ROOT,
  SWARMCLAW_HOME,
  WORKSPACE_DIR,
  locateStandaloneServer,
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

function main(args = process.argv.slice(3)) {
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

  process.env.SWARMCLAW_HOME = SWARMCLAW_HOME
  process.env.DATA_DIR = DATA_DIR
  process.env.WORKSPACE_DIR = WORKSPACE_DIR
  process.env.BROWSER_PROFILES_DIR = BROWSER_PROFILES_DIR
  process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES = '1'
  process.env.SWARMCLAW_WORKER_ONLY = '1'

  console.log('[swarmclaw] Starting dedicated background worker...')
  console.log(`[swarmclaw] Package root: ${PKG_ROOT}`)
  console.log(`[swarmclaw] Home: ${SWARMCLAW_HOME}`)
  console.log(`[swarmclaw] Data directory: ${DATA_DIR}`)
  console.log(`[swarmclaw] Workspace directory: ${WORKSPACE_DIR}`)
  console.log(`[swarmclaw] Browser profiles: ${BROWSER_PROFILES_DIR}`)

  const standalone = locateStandaloneServer()
  if (!standalone) {
    console.error('[swarmclaw] Standalone server.js not found in the installed package. Try running: swarmclaw server --build')
    process.exit(1)
  }
  const { root: runtimeRoot, serverJs } = standalone

  const child = spawn(process.execPath, [serverJs], {
    cwd: runtimeRoot,
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
