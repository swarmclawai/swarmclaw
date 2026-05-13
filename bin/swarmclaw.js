#!/usr/bin/env node
'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

// Legacy TS CLI groups/actions that provide richer, command-specific options.
const TS_CLI_ACTIONS = Object.freeze({
  agents: new Set(['list', 'get']),
  tasks: new Set(['list', 'get', 'create', 'update', 'delete', 'archive']),
  schedules: new Set(['list', 'get', 'create']),
  runs: new Set(['list', 'get']),
  sessions: new Set(['list', 'get', 'create', 'update', 'delete', 'history', 'mailbox', 'stop']),
  memory: new Set(['get', 'search', 'store', 'maintenance']),
  'memory-images': new Set(['get']),
  setup: new Set(['init', 'check-provider', 'doctor', 'openclaw-device']),
  connectors: new Set(['list', 'get', 'create', 'update', 'delete', 'start', 'stop', 'repair']),
  webhooks: new Set(['list', 'get', 'create', 'update', 'delete', 'trigger']),
})

const LEGACY_TS_CLI_ALIAS_MAP = Object.freeze({
  '--base-url': '--url',
  '--access-key': '--key',
})

function shouldUseLegacyTsCli(argv) {
  const group = argv[0]
  const action = argv[1]

  // Default to mapped CLI for top-level help/version and unknown groups.
  if (!group || group.startsWith('-')) return false

  const actions = TS_CLI_ACTIONS[group]
  if (!actions) return false

  // Prefer mapped CLI for group help so all API-backed actions are discoverable.
  if (!action || action === 'help' || action.startsWith('-')) return false

  return actions.has(action)
}

function supportsStripTypes() {
  return process.allowedNodeEnvironmentFlags.has('--experimental-strip-types')
}

function hasTsxRuntime() {
  try {
    require.resolve('tsx/package.json')
    return true
  } catch {
    return false
  }
}

function pathIsInsideNodeModules(filePath) {
  return path.resolve(filePath).split(path.sep).includes('node_modules')
}

function buildLegacyTsCliArgs(cliPath, argv, options = {}) {
  const ext = path.extname(cliPath).toLowerCase()
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
    return [cliPath, ...argv]
  }

  const insideNodeModules = options.insideNodeModules ?? pathIsInsideNodeModules(cliPath)
  const stripTypesSupported = options.supportsStripTypes ?? supportsStripTypes()
  if (stripTypesSupported && !insideNodeModules) {
    return ['--no-warnings', '--experimental-strip-types', cliPath, ...argv]
  }

  const tsxAvailable = options.hasTsxRuntime ?? hasTsxRuntime()
  if (tsxAvailable) {
    return ['--no-warnings', '--import', 'tsx', cliPath, ...argv]
  }

  return null
}

function resolveLegacyTsCliPath() {
  // Prefer the bundled compiled .js. The shipped .ts entrypoint requires either
  // Node's type-stripping (disabled under node_modules) or a tsx runtime
  // resolvable from the *spawned* process's CWD — both fragile when the CLI is
  // invoked from a project directory that doesn't itself depend on tsx. The
  // compiled .js is shipped right next to the .ts and is bytewise identical
  // functionality (runMappedCli already imports it).
  return path.join(__dirname, '..', 'src', 'cli', 'index.js')
}

function normalizeLegacyTsCliArgv(argv) {
  const normalized = []

  for (const token of argv) {
    if (!token.startsWith('--')) {
      normalized.push(token)
      continue
    }

    const eqIndex = token.indexOf('=')
    const flag = eqIndex > -1 ? token.slice(0, eqIndex) : token
    const mappedFlag = LEGACY_TS_CLI_ALIAS_MAP[flag]

    if (!mappedFlag) {
      normalized.push(token)
      continue
    }

    if (eqIndex > -1) {
      normalized.push(`${mappedFlag}=${token.slice(eqIndex + 1)}`)
    } else {
      normalized.push(mappedFlag)
    }
  }

  return normalized
}

function runLegacyTsCli(argv) {
  const cliPath = resolveLegacyTsCliPath()
  const args = buildLegacyTsCliArgs(cliPath, normalizeLegacyTsCliArgv(argv))
  const env = normalizeLegacyCliEnv(process.env)
  if (!args) {
    process.stderr.write('Legacy CLI commands require Node 22.6+ or an available local tsx runtime.\n')
    return 1
  }
  const child = spawnSync(
    process.execPath,
    args,
    { stdio: 'inherit', env },
  )

  if (child.error) {
    process.stderr.write(`${child.error.message}\n`)
    return 1
  }
  if (typeof child.status === 'number') return child.status
  return 1
}

function normalizeLegacyCliEnv(env) {
  const nextEnv = { ...env }
  if (!nextEnv.SWARMCLAW_URL && nextEnv.SWARMCLAW_BASE_URL) {
    nextEnv.SWARMCLAW_URL = nextEnv.SWARMCLAW_BASE_URL
  }
  if (!nextEnv.SWARMCLAW_ACCESS_KEY) {
    const key = nextEnv.SWARMCLAW_API_KEY || nextEnv.SC_ACCESS_KEY || ''
    if (key) nextEnv.SWARMCLAW_ACCESS_KEY = key
  }
  return nextEnv
}

function printPackageVersion() {
  const pkg = require('../package.json')
  process.stdout.write(`${pkg.name || 'swarmclaw'} ${pkg.version || '0.0.0'}\n`)
}

function printVersionHelp() {
  process.stdout.write(`
Usage: swarmclaw version

Show the installed SwarmClaw package version.
`.trim() + '\n')
}

function readUserServiceSwarmclawHome() {
  const homeDir = process.env.HOME || os.homedir()
  const servicePath = path.join(homeDir, '.config', 'systemd', 'user', 'swarmclaw.service')
  try {
    const text = fs.readFileSync(servicePath, 'utf8')
    const lines = text.split(/\r?\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('Environment=')) continue
      let value = trimmed.slice('Environment='.length).trim()
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1)
      }
      if (!value.startsWith('SWARMCLAW_HOME=')) continue
      const homeValue = value.slice('SWARMCLAW_HOME='.length).trim()
      if (homeValue) return homeValue
    }
  } catch {
    return null
  }
  return null
}

function getUserServicePath() {
  const homeDir = process.env.HOME || os.homedir()
  return path.join(homeDir, '.config', 'systemd', 'user', 'swarmclaw.service')
}

function hasUserSystemdService() {
  return fs.existsSync(getUserServicePath())
}

function runSystemctlUser(args) {
  return spawnSync('systemctl', ['--user', ...args], { stdio: 'inherit', env: process.env })
}

function hasServerLifecycleFlags(argv) {
  return argv.some((arg) => (
    arg === '--build'
    || arg === '-d'
    || arg === '--detach'
    || arg === '--port'
    || arg === '--ws-port'
    || arg === '--host'
  ))
}

function handleServiceLifecycle(top, argv) {
  // If the user passed host/port/build flags, fall back to local server-cmd behavior.
  const hasServerFlags = hasServerLifecycleFlags(argv)
  if (hasServerFlags || !hasUserSystemdService()) return false

  const unit = 'swarmclaw.service'
  if (top === 'run' || top === 'start') {
    const started = runSystemctlUser(['start', unit])
    if (typeof started.status === 'number') process.exitCode = started.status
    return true
  }
  if (top === 'stop') {
    const stopped = runSystemctlUser(['stop', unit])
    if (typeof stopped.status === 'number') process.exitCode = stopped.status
    return true
  }

  return false
}

function applyServiceHomeDefault() {
  if (typeof process.env.SWARMCLAW_HOME === 'string' && process.env.SWARMCLAW_HOME.trim()) return
  const serviceHome = readUserServiceSwarmclawHome()
  if (serviceHome) process.env.SWARMCLAW_HOME = serviceHome
}

async function runMappedCli(argv) {
  const cliPath = path.join(__dirname, '..', 'src', 'cli', 'index.js')
  const cliModule = await import(cliPath)
  const runCli = cliModule.runCli || (cliModule.default && cliModule.default.runCli)
  if (typeof runCli !== 'function') {
    throw new Error('Unable to load API-mapped CLI runtime')
  }
  return runCli(argv)
}

async function runHelp(argv) {
  const [target, ...rest] = argv
  if (!target) {
    const code = await runMappedCli(['--help'])
    process.exitCode = typeof code === 'number' ? code : 1
    return
  }

  if (target === 'run' || target === 'start' || target === 'stop' || target === 'status' || target === 'server') {
    await require('./server-cmd.js').main(['--help'])
    return
  }
  if (target === 'daemon') {
    await require('./daemon-cmd.js').main(['--help'])
    return
  }
  if (target === 'worker') {
    require('./worker-cmd.js').main(['--help'])
    return
  }
  if (target === 'doctor') {
    require('./doctor-cmd.js').main(['--help'])
    return
  }
  if (target === 'update') {
    require('./update-cmd.js').main(['--help'])
    return
  }
  if (target === 'version') {
    printVersionHelp()
    return
  }

  const forwarded = rest.includes('--help') || rest.includes('-h')
    ? [target, ...rest]
    : [target, ...rest, '--help']
  const code = shouldUseLegacyTsCli(forwarded)
    ? runLegacyTsCli(forwarded)
    : await runMappedCli(forwarded)

  process.exitCode = typeof code === 'number' ? code : 1
}

async function main() {
  applyServiceHomeDefault()

  const argv = process.argv.slice(2)
  const top = argv[0]

  // Default to 'server' when invoked with no arguments.
  if (!top) {
    await require('./server-cmd.js').main([])
    return
  }

  if (top === '-v') {
    printPackageVersion()
    return
  }

  if (top === 'version' && argv.length === 1) {
    printPackageVersion()
    return
  }

  if (top === 'help') {
    await runHelp(argv.slice(1))
    return
  }

  // Route local lifecycle/maintenance commands to CJS scripts (no TS dependency).
  if (top === 'server') {
    await require('./server-cmd.js').main(argv.slice(1))
    return
  }
  if (top === 'daemon') {
    const subcommand = argv[1]
    if (!subcommand || subcommand === 'run' || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      await require('./daemon-cmd.js').main(argv.slice(1))
      return
    }
  }
  if (top === 'run' || top === 'start') {
    if (handleServiceLifecycle(top, argv.slice(1))) return
    await require('./server-cmd.js').main(argv.slice(1))
    return
  }
  if (top === 'status' || top === 'stop') {
    if (top === 'status' && hasUserSystemdService() && !hasServerLifecycleFlags(argv.slice(1))) {
      const serviceStatus = runSystemctlUser(['status', 'swarmclaw.service', '--no-pager'])
      const apiStatusCode = await runMappedCli(['system-status', 'get'])
      const serviceCode = typeof serviceStatus.status === 'number' ? serviceStatus.status : 1
      const apiCode = typeof apiStatusCode === 'number' ? apiStatusCode : 1
      process.exitCode = serviceCode !== 0 ? serviceCode : apiCode
      return
    }
    if (handleServiceLifecycle(top, argv.slice(1))) return
    await require('./server-cmd.js').main([top, ...argv.slice(1)])
    return
  }
  if (top === 'worker') {
    require('./worker-cmd.js').main()
    return
  }
  if (top === 'doctor') {
    require('./doctor-cmd.js').main(argv.slice(1))
    return
  }
  if (top === 'update') {
    require('./update-cmd.js').main()
    return
  }

  const code = shouldUseLegacyTsCli(argv)
    ? runLegacyTsCli(argv)
    : await runMappedCli(argv)

  process.exitCode = typeof code === 'number' ? code : 1
}

if (require.main === module) {
  void main().catch((err) => {
    process.stderr.write(`${err?.message || String(err)}\n`)
    process.exit(1)
  })
}

module.exports = {
  buildLegacyTsCliArgs,
  hasTsxRuntime,
  normalizeLegacyTsCliArgv,
  pathIsInsideNodeModules,
  resolveLegacyTsCliPath,
  TS_CLI_ACTIONS,
  normalizeLegacyCliEnv,
  printPackageVersion,
  supportsStripTypes,
  shouldUseLegacyTsCli,
}
