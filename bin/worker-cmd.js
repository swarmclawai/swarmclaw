#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

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

  const SWARMCLAW_HOME = process.env.SWARMCLAW_HOME || path.join(os.homedir(), '.swarmclaw')
  const DATA_DIR = path.join(SWARMCLAW_HOME, 'data')

  process.env.DATA_DIR = DATA_DIR
  process.env.SWARMCLAW_DAEMON_BACKGROUND_SERVICES = '1'
  // Flag that tells Next.js NOT to start the HTTP/Websocket listener, just boot the daemon.
  process.env.SWARMCLAW_WORKER_ONLY = '1'

  console.log(`[swarmclaw] Starting dedicated background worker...`)
  console.log(`[swarmclaw] Data directory: ${DATA_DIR}`)

  // We reuse the built server.js but signal it to only run the daemon
  const standaloneBase = path.join(SWARMCLAW_HOME, '.next', 'standalone')
  let serverJs = path.join(standaloneBase, 'server.js')
  
  if (!fs.existsSync(serverJs)) {
     console.error('Standalone server.js not found. Try running: swarmclaw server --build')
     process.exit(1)
  }

  const child = spawn(process.execPath, [serverJs], {
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
