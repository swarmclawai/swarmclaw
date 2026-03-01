#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn, execSync } = require('node:child_process')
const os = require('node:os')

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SWARMCLAW_HOME = process.env.SWARMCLAW_HOME || path.join(os.homedir(), '.swarmclaw')
const PKG_ROOT = path.resolve(__dirname, '..')
const BUILT_MARKER = path.join(SWARMCLAW_HOME, '.built')
const PID_FILE = path.join(SWARMCLAW_HOME, 'server.pid')
const LOG_FILE = path.join(SWARMCLAW_HOME, 'server.log')
const DATA_DIR = path.join(SWARMCLAW_HOME, 'data')

// Files/directories to copy from the npm package into SWARMCLAW_HOME
const BUILD_COPY_ENTRIES = [
  'src',
  'public',
  'next.config.ts',
  'tsconfig.json',
  'postcss.config.mjs',
  'package.json',
  'package-lock.json',
]

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

function copyPath(src, dest, { dereference = true } = {}) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(src, dest, { recursive: true, dereference })
}

function symlinkPath(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.symlinkSync(src, dest)
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function needsBuild(forceBuild) {
  if (forceBuild) return true
  if (!fs.existsSync(BUILT_MARKER)) return true
  return false
}

function runBuild() {
  log('Preparing build environment...')
  ensureDir(SWARMCLAW_HOME)
  ensureDir(DATA_DIR)

  // Copy source/config into SWARMCLAW_HOME. Turbopack build currently rejects
  // app source symlinks that point outside the workspace root.
  for (const entry of BUILD_COPY_ENTRIES) {
    const src = path.join(PKG_ROOT, entry)
    const dest = path.join(SWARMCLAW_HOME, entry)

    if (!fs.existsSync(src)) {
      log(`Warning: ${entry} not found in package, skipping`)
      continue
    }

    copyPath(src, dest)
  }

  // Reuse package dependencies via symlink to avoid multi-GB duplication in
  // SWARMCLAW_HOME. Build runs with webpack mode for symlink compatibility.
  const nmSrc = path.join(PKG_ROOT, 'node_modules')
  const nmDest = path.join(SWARMCLAW_HOME, 'node_modules')
  if (fs.existsSync(nmSrc)) {
    symlinkPath(nmSrc, nmDest)
  } else {
    // If node_modules doesn't exist at PKG_ROOT, install
    log('Installing dependencies...')
    execSync('npm install', { cwd: SWARMCLAW_HOME, stdio: 'inherit' })
  }

  // Run Next.js build
  log('Building Next.js application (this may take a minute)...')
  // Use webpack for production build reliability in packaged/fresh-install
  // environments (Turbopack has intermittently failed during prerender).
  execSync('npx next build --webpack', {
    cwd: SWARMCLAW_HOME,
    stdio: 'inherit',
    env: {
      ...process.env,
      SWARMCLAW_BUILD_MODE: '1',
    },
  })

  // Write built marker
  fs.writeFileSync(BUILT_MARKER, JSON.stringify({ builtAt: new Date().toISOString(), version: getVersion() }))
  log('Build complete.')
}

function getVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'))
    return pkg.version || 'unknown'
  } catch {
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// Find standalone server.js
// ---------------------------------------------------------------------------

function findStandaloneServer() {
  // Next.js standalone output creates .next/standalone/ with server.js
  // The path mirrors the build machine's directory structure
  const standaloneBase = path.join(SWARMCLAW_HOME, '.next', 'standalone')

  if (!fs.existsSync(standaloneBase)) {
    return null
  }

  // Try direct server.js first
  const direct = path.join(standaloneBase, 'server.js')
  if (fs.existsSync(direct)) return direct

  // Recursively search for server.js (handles nested paths from build machine)
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

function startServer(opts) {
  const serverJs = findStandaloneServer()
  if (!serverJs) {
    logError('Standalone server.js not found. Try running: swarmclaw server --build')
    process.exit(1)
  }

  const port = opts.port || '3456'
  const wsPort = opts.wsPort || String(Number(port) + 1)
  const host = opts.host || '0.0.0.0'

  const env = {
    ...process.env,
    PORT: port,
    WS_PORT: wsPort,
    HOSTNAME: host,
    DATA_DIR,
  }

  log(`Starting server on ${host}:${port} (WebSocket: ${wsPort})...`)
  log(`Data directory: ${DATA_DIR}`)

  if (opts.detach) {
    // Detached mode — run in background
    const logStream = fs.openSync(LOG_FILE, 'a')
    const child = spawn(process.execPath, [serverJs], {
      env,
      detached: true,
      stdio: ['ignore', logStream, logStream],
    })

    child.unref()
    fs.writeFileSync(PID_FILE, String(child.pid))
    log(`Server started in background (PID: ${child.pid})`)
    log(`Logs: ${LOG_FILE}`)
    process.exit(0)
  } else {
    // Foreground mode
    const child = spawn(process.execPath, [serverJs], {
      env,
      stdio: 'inherit',
    })

    child.on('exit', (code) => {
      process.exit(code || 0)
    })

    // Forward signals
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
    return
  }

  if (isProcessRunning(pid)) {
    log(`Server: running (PID: ${pid})`)
  } else {
    log(`Server: not running (stale PID: ${pid})`)
    try { fs.unlinkSync(PID_FILE) } catch {}
  }

  log(`Home: ${SWARMCLAW_HOME}`)
  log(`Data: ${DATA_DIR}`)
  log(`WebSocket port: ${process.env.WS_PORT || '(PORT + 1)'}`)

  if (fs.existsSync(BUILT_MARKER)) {
    try {
      const info = JSON.parse(fs.readFileSync(BUILT_MARKER, 'utf8'))
      log(`Built: ${info.builtAt || 'unknown'} (v${info.version || '?'})`)
    } catch {
      log('Built: yes')
    }
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
  const args = process.argv.slice(3) // skip node, bin, 'server'
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

  // command === 'start'
  if (needsBuild(forceBuild)) {
    runBuild()
  }

  startServer({ port, wsPort, host, detach })
}

main()
