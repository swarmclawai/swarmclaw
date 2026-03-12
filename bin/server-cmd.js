#!/usr/bin/env node
'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const os = require('node:os')
const {
  detectPackageManager,
  getInstallCommand,
} = require('./package-manager.js')
const {
  readPackageVersion,
  resolvePackageRoot,
} = require('./install-root.js')

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SWARMCLAW_HOME = process.env.SWARMCLAW_HOME || path.join(os.homedir(), '.swarmclaw')
const PKG_ROOT = resolvePackageRoot({
  moduleDir: __dirname,
  argv1: process.argv[1],
  cwd: process.cwd(),
})
const PID_FILE = path.join(SWARMCLAW_HOME, 'server.pid')
const LOG_FILE = path.join(SWARMCLAW_HOME, 'server.log')
const DATA_DIR = path.join(SWARMCLAW_HOME, 'data')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function log(msg) {
  process.stdout.write(`[swarmclaw] ${msg}\n`)
}

function logError(msg) {
  process.stderr.write(`[swarmclaw] ${msg}\n`)
}

function readPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function resolveStandaloneBase(pkgRoot = PKG_ROOT) {
  return path.join(pkgRoot, '.next', 'standalone')
}

function getVersion() {
  return readPackageVersion(PKG_ROOT) || 'unknown'
}

function ensurePackageDependencies(pkgRoot = PKG_ROOT) {
  const nextCli = path.join(pkgRoot, 'node_modules', 'next', 'dist', 'bin', 'next')
  if (fs.existsSync(nextCli)) return nextCli

  const packageManager = detectPackageManager(pkgRoot, process.env)
  const install = getInstallCommand(packageManager)
  log(`Installing dependencies with ${packageManager}...`)
  execFileSync(install.command, install.args, { cwd: pkgRoot, stdio: 'inherit' })
  return nextCli
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function needsBuild(forceBuild, { pkgRoot = PKG_ROOT } = {}) {
  if (forceBuild) return true
  return !findStandaloneServer({ pkgRoot })
}

function runBuild({ pkgRoot = PKG_ROOT } = {}) {
  log('Preparing build environment...')
  ensureDir(SWARMCLAW_HOME)
  ensureDir(DATA_DIR)

  const nextCli = ensurePackageDependencies(pkgRoot)

  log('Building Next.js application (this may take a minute)...')
  execFileSync(process.execPath, [nextCli, 'build'], {
    cwd: pkgRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      DATA_DIR,
      SWARMCLAW_BUILD_MODE: '1',
    },
  })

  log('Build complete.')
}

// ---------------------------------------------------------------------------
// Find standalone server.js
// ---------------------------------------------------------------------------

function findStandaloneServer({ pkgRoot = PKG_ROOT } = {}) {
  const standaloneBase = resolveStandaloneBase(pkgRoot)

  if (!fs.existsSync(standaloneBase)) {
    return null
  }

  const direct = path.join(standaloneBase, 'server.js')
  if (fs.existsSync(direct)) return direct

  function search(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isFile() && entry.name === 'server.js') return full
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        const found = search(full)
        if (found) return found
      }
    }
    return null
  }

  return search(standaloneBase)
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

function startServer(opts, { pkgRoot = PKG_ROOT } = {}) {
  const serverJs = findStandaloneServer({ pkgRoot })
  if (!serverJs) {
    logError('Standalone server.js not found in the installed package. Try running: swarmclaw server --build')
    process.exit(1)
  }

  ensureDir(SWARMCLAW_HOME)
  ensureDir(DATA_DIR)

  const port = opts.port || '3456'
  const wsPort = opts.wsPort || String(Number(port) + 1)
  const host = opts.host || '0.0.0.0'

  const env = {
    ...process.env,
    DATA_DIR,
    HOSTNAME: host,
    PORT: port,
    WS_PORT: wsPort,
  }

  log(`Starting server on ${host}:${port} (WebSocket: ${wsPort})...`)
  log(`Package root: ${pkgRoot}`)
  log(`Data directory: ${DATA_DIR}`)

  if (opts.detach) {
    const logStream = fs.openSync(LOG_FILE, 'a')
    const child = spawn(process.execPath, [serverJs], {
      cwd: pkgRoot,
      detached: true,
      env,
      stdio: ['ignore', logStream, logStream],
    })

    child.unref()
    fs.writeFileSync(PID_FILE, String(child.pid))
    log(`Server started in background (PID: ${child.pid})`)
    log(`Logs: ${LOG_FILE}`)
    process.exit(0)
  } else {
    const child = spawn(process.execPath, [serverJs], {
      cwd: pkgRoot,
      env,
      stdio: 'inherit',
    })

    child.on('exit', (code) => {
      process.exit(code || 0)
    })

    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => child.kill(sig))
    }
  }
}

// ---------------------------------------------------------------------------
// Stop server
// ---------------------------------------------------------------------------

function stopServer() {
  const pid = readPid()
  if (!pid) {
    log('No PID file found. Server may not be running in detached mode.')
    return
  }

  if (!isProcessRunning(pid)) {
    log(`Process ${pid} is not running. Cleaning up PID file.`)
    try { fs.unlinkSync(PID_FILE) } catch {}
    return
  }

  log(`Stopping server (PID: ${pid})...`)
  try {
    process.kill(pid, 'SIGTERM')
    log('Server stopped.')
  } catch (err) {
    logError(`Failed to stop server: ${err.message}`)
  }
  try { fs.unlinkSync(PID_FILE) } catch {}
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function showStatus() {
  const pid = readPid()
  if (!pid) {
    log('Server: not running (no PID file)')
  } else if (isProcessRunning(pid)) {
    log(`Server: running (PID: ${pid})`)
  } else {
    log(`Server: not running (stale PID: ${pid})`)
    try { fs.unlinkSync(PID_FILE) } catch {}
  }

  log(`Package: ${PKG_ROOT}`)
  log(`Home: ${SWARMCLAW_HOME}`)
  log(`Data: ${DATA_DIR}`)
  log(`WebSocket port: ${process.env.WS_PORT || '(PORT + 1)'}`)

  const serverJs = findStandaloneServer()
  if (serverJs) {
    log(`Built: yes (${serverJs})`)
  } else {
    log('Built: no')
  }
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function printHelp() {
  const help = `
Usage: swarmclaw server [command] [options]

Commands:
  start          Start the server (default)
  stop           Stop a detached server
  status         Show server status

Options:
  --build           Force rebuild before starting
  -d, --detach      Start server in background
  --port <port>     Server port (default: 3456)
  --ws-port <port>  WebSocket port (default: PORT + 1)
  --host <host>     Server host (default: 0.0.0.0)
  -h, --help        Show this help message
`.trim()
  console.log(help)
}

function main() {
  const args = process.argv.slice(3)
  let command = 'start'
  let forceBuild = false
  let detach = false
  let port = null
  let wsPort = null
  let host = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === 'start') {
      command = 'start'
    } else if (arg === 'stop') {
      command = 'stop'
    } else if (arg === 'status') {
      command = 'status'
    } else if (arg === '--build') {
      forceBuild = true
    } else if (arg === '-d' || arg === '--detach') {
      detach = true
    } else if (arg === '--port' && i + 1 < args.length) {
      port = args[++i]
    } else if (arg === '--ws-port' && i + 1 < args.length) {
      wsPort = args[++i]
    } else if (arg === '--host' && i + 1 < args.length) {
      host = args[++i]
    } else if (arg === '-h' || arg === '--help') {
      printHelp()
      process.exit(0)
    } else {
      logError(`Unknown argument: ${arg}`)
      printHelp()
      process.exit(1)
    }
  }

  if (command === 'stop') {
    stopServer()
    return
  }

  if (command === 'status') {
    showStatus()
    return
  }

  if (needsBuild(forceBuild)) {
    runBuild()
  }

  startServer({ port, wsPort, host, detach })
}

if (require.main === module) {
  main()
}

module.exports = {
  DATA_DIR,
  PKG_ROOT,
  SWARMCLAW_HOME,
  findStandaloneServer,
  getVersion,
  main,
  needsBuild,
  resolveStandaloneBase,
  runBuild,
}
