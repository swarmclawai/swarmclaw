#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const args = new Set(process.argv.slice(2))
const startAfterSetup = args.has('--start') || args.has('--prod')
const productionMode = args.has('--prod')
const skipInstall = args.has('--skip-install')
const cwd = process.cwd()

function log(message) {
  process.stdout.write(`[setup] ${message}\n`)
}

function fail(message, code = 1) {
  process.stderr.write(`[setup] ERROR: ${message}\n`)
  process.exit(code)
}

function run(command, commandArgs, options = {}) {
  const printable = `${command} ${commandArgs.join(' ')}`.trim()
  log(`$ ${printable}`)
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    ...options,
  })
  if (result.error) fail(result.error.message)
  if ((result.status ?? 1) !== 0) {
    fail(`Command failed: ${printable}`, result.status ?? 1)
  }
}

function ensureNodeVersion() {
  const version = process.versions.node
  const major = Number.parseInt(version.split('.')[0] || '0', 10)
  if (major < 20) {
    fail(`Detected Node ${version}. SwarmClaw requires Node 20 or newer.`)
  }
  log(`Node ${version} detected.`)
}

function ensureNpm() {
  const result = spawnSync('npm', ['--version'], { cwd, encoding: 'utf8' })
  if (result.error || (result.status ?? 1) !== 0) {
    fail('npm was not found. Install npm and rerun this setup command.')
  }
  log(`npm ${String(result.stdout || '').trim()} detected.`)
}

function commandExists(name) {
  const lookup = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(lookup, [name], { cwd, encoding: 'utf8' })
  return !result.error && (result.status ?? 1) === 0
}

function prependDenoPath() {
  const home = process.env.HOME || process.env.USERPROFILE
  if (!home) return
  const denoBinDir = path.join(home, '.deno', 'bin')
  const currentPath = process.env.PATH || ''
  const segments = currentPath.split(path.delimiter).filter(Boolean)
  if (!segments.includes(denoBinDir)) {
    process.env.PATH = `${denoBinDir}${path.delimiter}${currentPath}`
  }
}

function detectDenoBinary() {
  if (commandExists('deno')) return 'deno'
  const home = process.env.HOME || process.env.USERPROFILE
  if (!home) return null
  const binName = process.platform === 'win32' ? 'deno.exe' : 'deno'
  const localBinary = path.join(home, '.deno', 'bin', binName)
  return fs.existsSync(localBinary) ? localBinary : null
}

function readDenoVersion(binary) {
  const result = spawnSync(binary, ['--version'], { cwd, encoding: 'utf8' })
  if (result.error || (result.status ?? 1) !== 0) return null
  const versionLine = String(result.stdout || '').split('\n').map((line) => line.trim()).find(Boolean)
  return versionLine || null
}

function ensureDeno() {
  prependDenoPath()
  const currentBinary = detectDenoBinary()
  const currentVersion = currentBinary ? readDenoVersion(currentBinary) : null
  if (currentVersion) {
    log(`Deno runtime detected (${currentVersion}).`)
    return
  }

  if (process.platform === 'win32') {
    fail('Deno is required for the SwarmClaw sandbox runtime. Install Deno from https://deno.land/#installation and rerun setup.')
  }

  log('Deno not found. Installing Deno (sandbox runtime)...')
  const install = spawnSync('sh', ['-c', 'curl -fsSL https://deno.land/install.sh | sh'], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  })
  if (install.error || (install.status ?? 1) !== 0) {
    fail('Failed to install Deno automatically. Install it manually from https://deno.land/#installation and rerun setup.')
  }

  prependDenoPath()
  const installedBinary = detectDenoBinary()
  const installedVersion = installedBinary ? readDenoVersion(installedBinary) : null
  if (!installedVersion) {
    fail('Deno was installed but is not on PATH for this shell. Add ~/.deno/bin to PATH, then rerun setup.')
  }
  log(`Deno installed (${installedVersion}).`)
}

function ensureProjectRoot() {
  const pkgPath = path.join(cwd, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    fail(`package.json was not found in ${cwd}. Run this command from the SwarmClaw project root.`)
  }
}

function ensureEnvFile() {
  const envPath = path.join(cwd, '.env.local')
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(
      envPath,
      '# SwarmClaw local environment variables\n# ACCESS_KEY and CREDENTIAL_SECRET are auto-generated on first app run.\n',
      'utf8',
    )
    log('Created .env.local.')
  } else {
    log('.env.local already exists.')
  }
}

function ensureDataDir() {
  const dataDir = path.join(cwd, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  log(`Data directory ready at ${dataDir}.`)
}

function printNextSteps() {
  process.stdout.write('\n')
  log('Setup complete.')
  process.stdout.write('\n')
  process.stdout.write('Next steps:\n')
  process.stdout.write('1. Run `npm run dev`.\n')
  process.stdout.write('2. Open http://localhost:3456 in your browser.\n')
  process.stdout.write('3. Copy the access key printed in the terminal and finish the setup wizard.\n')
  process.stdout.write('   Or run `npx swarmclaw setup init` for interactive CLI setup.\n')
  process.stdout.write('4. For updates later, run `npm run update:easy`.\n')
}

function main() {
  ensureProjectRoot()
  ensureNodeVersion()
  ensureNpm()
  ensureDeno()
  ensureDataDir()
  ensureEnvFile()

  if (!skipInstall) {
    run('npm', ['install'])
  } else {
    log('Skipping dependency install (--skip-install).')
  }

  if (productionMode) {
    run('npm', ['run', 'build'])
  }

  if (startAfterSetup) {
    run('npm', ['run', productionMode ? 'start' : 'dev'])
    return
  }

  printNextSteps()
}

main()
