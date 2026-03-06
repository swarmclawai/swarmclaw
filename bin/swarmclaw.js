#!/usr/bin/env node
'use strict'

const path = require('node:path')
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

function runLegacyTsCli(argv) {
  const cliPath = path.join(__dirname, '..', 'src', 'cli', 'index.ts')
  const env = normalizeLegacyCliEnv(process.env)
  const child = spawnSync(
    process.execPath,
    ['--no-warnings', '--experimental-strip-types', cliPath, ...argv],
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

async function runMappedCli(argv) {
  const cliPath = path.join(__dirname, '..', 'src', 'cli', 'index.js')
  const cliModule = await import(cliPath)
  const runCli = cliModule.runCli || (cliModule.default && cliModule.default.runCli)
  if (typeof runCli !== 'function') {
    throw new Error('Unable to load API-mapped CLI runtime')
  }
  return runCli(argv)
}

async function main() {
  const argv = process.argv.slice(2)
  const top = argv[0]

  // Route 'server' and 'update' subcommands to CJS scripts (no TS dependency).
  if (top === 'server') {
    require('./server-cmd.js').main()
    return
  }
  if (top === 'update') {
    require('./update-cmd.js')
    return
  }

  const code = shouldUseLegacyTsCli(argv)
    ? runLegacyTsCli(argv)
    : await runMappedCli(argv)

  process.exitCode = typeof code === 'number' ? code : 1
}

if (require.main === module) {
  void main()
}

module.exports = {
  TS_CLI_ACTIONS,
  normalizeLegacyCliEnv,
  shouldUseLegacyTsCli,
}
