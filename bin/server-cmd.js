#!/usr/bin/env node
'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const {
  detectPackageManager,
  getInstallCommand,
} = require('./package-manager.js')
const {
  readPackageVersion,
  resolvePackageRoot,
  resolveStateHome,
} = require('./install-root.js')

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PKG_ROOT = resolvePackageRoot({
  moduleDir: __dirname,
  argv1: process.argv[1],
  cwd: process.cwd(),
})
const SWARMCLAW_HOME = resolveStateHome({
  pkgRoot: PKG_ROOT,
  moduleDir: __dirname,
  argv1: process.argv[1],
  cwd: process.cwd(),
  env: process.env,
})
const PID_FILE = path.join(SWARMCLAW_HOME, 'server.pid')
const LOG_FILE = path.join(SWARMCLAW_HOME, 'server.log')
const DATA_DIR = path.join(SWARMCLAW_HOME, 'data')
const WORKSPACE_DIR = path.join(SWARMCLAW_HOME, 'workspace')
const BROWSER_PROFILES_DIR = path.join(SWARMCLAW_HOME, 'browser-profiles')
const BUILD_WORKSPACES_DIR = path.join(SWARMCLAW_HOME, 'builds')

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

function resolveReadyCheckHost(host) {
  if (host === '0.0.0.0') return '127.0.0.1'
  if (host === '::') return '::1'
  return host
}

function probeHttpReady(host, port, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host,
        port: Number(port),
        path: '/api/auth',
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        res.resume()
        resolve(res.statusCode >= 200 && res.statusCode < 500)
      },
    )

    req.once('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.once('error', () => resolve(false))
    req.end()
  })
}

async function waitForPortReady({
  host,
  port,
  timeoutMs = 30_000,
  intervalMs = 250,
  pid = null,
  isProcessRunningFn = isProcessRunning,
  probeFn = probeHttpReady,
} = {}) {
  const readyHost = resolveReadyCheckHost(host)
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (pid && !isProcessRunningFn(pid)) {
      throw new Error(`Detached server process ${pid} exited before becoming ready.`)
    }

    if (await probeFn(readyHost, port)) return

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`Timed out waiting for ${readyHost}:${port} to become ready.`)
}

function resolveStandaloneBase(pkgRoot = PKG_ROOT) {
  return path.join(pkgRoot, '.next', 'standalone')
}

function isGitCheckout(pkgRoot = PKG_ROOT) {
  return fs.existsSync(path.join(pkgRoot, '.git'))
}

function getVersion() {
  return readPackageVersion(PKG_ROOT) || 'unknown'
}

function resolveInstalledNext(pkgRoot = PKG_ROOT) {
  try {
    const nextPackageJson = require.resolve('next/package.json', { paths: [pkgRoot] })
    const nextPackageDir = path.dirname(nextPackageJson)
    return {
      nextCli: path.join(nextPackageDir, 'dist', 'bin', 'next'),
      nodeModulesDir: path.dirname(nextPackageDir),
    }
  } catch {
    return null
  }
}

function ensurePackageDependencies(pkgRoot = PKG_ROOT) {
  const resolved = resolveInstalledNext(pkgRoot)
  if (resolved && fs.existsSync(resolved.nextCli)) return resolved

  const packageManager = detectPackageManager(pkgRoot, process.env)
  const install = getInstallCommand(packageManager)
  log(`Installing dependencies with ${packageManager}...`)
  execFileSync(install.command, install.args, { cwd: pkgRoot, stdio: 'inherit' })

  const installed = resolveInstalledNext(pkgRoot)
  if (installed && fs.existsSync(installed.nextCli)) return installed

  throw new Error('Next.js CLI was not found after installing dependencies.')
}

function resolvePackageBuildRoot(pkgRoot = PKG_ROOT) {
  if (isGitCheckout(pkgRoot)) return pkgRoot
  const version = readPackageVersion(pkgRoot) || 'unknown'
  return path.join(BUILD_WORKSPACES_DIR, `package-${version}`)
}

function copyBuildWorkspaceContents(sourceRoot, targetRoot) {
  const excluded = new Set([
    '.git',
    '.next',
    'data',
    'node_modules',
  ])

  ensureDir(targetRoot)

  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue

    const sourcePath = path.join(sourceRoot, entry.name)
    const targetPath = path.join(targetRoot, entry.name)
    fs.rmSync(targetPath, { recursive: true, force: true })
    fs.cpSync(sourcePath, targetPath, {
      recursive: true,
      force: true,
      dereference: true,
    })
  }
}

function symlinkDir(targetPath, linkPath) {
  fs.rmSync(linkPath, { recursive: true, force: true })
  fs.symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

function prepareBuildWorkspace({ pkgRoot = PKG_ROOT, buildRoot = resolvePackageBuildRoot(pkgRoot), nodeModulesDir } = {}) {
  copyBuildWorkspaceContents(pkgRoot, buildRoot)
  symlinkDir(nodeModulesDir, path.join(buildRoot, 'node_modules'))
  return buildRoot
}

function resolveStandaloneCandidateRoots(pkgRoot = PKG_ROOT) {
  const roots = [pkgRoot]
  const buildRoot = resolvePackageBuildRoot(pkgRoot)
  if (buildRoot !== pkgRoot) roots.push(buildRoot)
  return roots
}

function locateStandaloneServer({ pkgRoot = PKG_ROOT } = {}) {
  for (const root of resolveStandaloneCandidateRoots(pkgRoot)) {
    const standaloneBase = resolveStandaloneBase(root)
    if (!fs.existsSync(standaloneBase)) continue

    const direct = path.join(standaloneBase, 'server.js')
    if (fs.existsSync(direct)) {
      return { root, serverJs: direct }
    }

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

    const nested = search(standaloneBase)
    if (nested) {
      return { root, serverJs: nested }
    }
  }

  return null
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

  const { nextCli, nodeModulesDir } = ensurePackageDependencies(pkgRoot)
  const buildRoot = resolvePackageBuildRoot(pkgRoot)

  if (buildRoot !== pkgRoot) {
    prepareBuildWorkspace({ pkgRoot, buildRoot, nodeModulesDir })
    log(`Using build workspace: ${buildRoot}`)
  }

  log('Building Next.js application (this may take a minute)...')
  execFileSync(process.execPath, [nextCli, 'build', '--webpack'], {
    cwd: buildRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      SWARMCLAW_HOME,
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
  return locateStandaloneServer({ pkgRoot })?.serverJs || null
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

async function startServer(opts, { pkgRoot = PKG_ROOT } = {}) {
  const standalone = locateStandaloneServer({ pkgRoot })
  if (!standalone) {
    logError('Standalone server.js not found in the installed package. Try running: swarmclaw server --build')
    process.exit(1)
  }
  const { root: runtimeRoot, serverJs } = standalone

  ensureDir(SWARMCLAW_HOME)
  ensureDir(DATA_DIR)

  const port = opts.port || '3456'
  const wsPort = opts.wsPort || String(Number(port) + 1)
  const host = opts.host || '0.0.0.0'

  const env = {
    ...process.env,
    SWARMCLAW_HOME,
    DATA_DIR,
    WORKSPACE_DIR,
    BROWSER_PROFILES_DIR,
    HOSTNAME: host,
    PORT: port,
    WS_PORT: wsPort,
  }

  log(`Starting server on ${host}:${port} (WebSocket: ${wsPort})...`)
  log(`Package root: ${pkgRoot}`)
  log(`Runtime root: ${runtimeRoot}`)
  log(`Home: ${SWARMCLAW_HOME}`)
  log(`Data directory: ${DATA_DIR}`)

  if (opts.detach) {
    const logStream = fs.openSync(LOG_FILE, 'a')
    const child = spawn(process.execPath, [serverJs], {
      cwd: runtimeRoot,
      detached: true,
      env,
      stdio: ['ignore', logStream, logStream],
    })

    fs.writeFileSync(PID_FILE, String(child.pid))
    try {
      await waitForPortReady({ host, port, pid: child.pid })
      child.unref()
      log(`Server started in background (PID: ${child.pid})`)
      log(`Logs: ${LOG_FILE}`)
      process.exit(0)
    } catch (err) {
      try {
        if (isProcessRunning(child.pid)) process.kill(child.pid, 'SIGTERM')
      } catch {}
      try { fs.unlinkSync(PID_FILE) } catch {}
      logError(`Detached start failed: ${err.message}`)
      logError(`Check logs: ${LOG_FILE}`)
      process.exit(1)
    }
  } else {
    const child = spawn(process.execPath, [serverJs], {
      cwd: runtimeRoot,
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
  log(`Build workspace: ${resolvePackageBuildRoot()}`)
  log(`Home: ${SWARMCLAW_HOME}`)
  log(`Data: ${DATA_DIR}`)
  log(`Workspace: ${WORKSPACE_DIR}`)
  log(`Browser profiles: ${BROWSER_PROFILES_DIR}`)
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

async function main(args = process.argv.slice(3)) {
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
    if (!forceBuild) {
      const installKind = isGitCheckout() ? 'checkout' : 'installed package'
      log(`Standalone server bundle not found in this ${installKind}. Building locally...`)
    }
    try {
      runBuild()
    } catch (err) {
      logError(`Build failed: ${err.message}`)
      logError('Retry manually with: swarmclaw server --build')
      process.exit(1)
    }
  }

  await startServer({ port, wsPort, host, detach })
}

if (require.main === module) {
  void main().catch((err) => {
    logError(err?.message || String(err))
    process.exit(1)
  })
}

module.exports = {
  DATA_DIR,
  BUILD_WORKSPACES_DIR,
  BROWSER_PROFILES_DIR,
  PKG_ROOT,
  SWARMCLAW_HOME,
  WORKSPACE_DIR,
  findStandaloneServer,
  getVersion,
  isGitCheckout,
  locateStandaloneServer,
  main,
  needsBuild,
  prepareBuildWorkspace,
  resolveInstalledNext,
  resolvePackageBuildRoot,
  resolveReadyCheckHost,
  resolveStandaloneCandidateRoots,
  resolveStandaloneBase,
  runBuild,
  waitForPortReady,
}
