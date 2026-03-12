#!/usr/bin/env node
'use strict'

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs')
const path = require('node:path')

const { readPackageVersion } = require('./install-root.js')
const {
  PKG_ROOT,
  SWARMCLAW_HOME,
  findStandaloneServer,
  isGitCheckout,
  resolvePackageBuildRoot,
  resolveInstalledNext,
} = require('./server-cmd.js')

function readPid(pidFile) {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
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

function buildDoctorReport(opts = {}) {
  const pkgRoot = opts.pkgRoot || PKG_ROOT
  const homeDir = opts.homeDir || SWARMCLAW_HOME
  const pidFile = path.join(homeDir, 'server.pid')
  const dataDir = path.join(homeDir, 'data')
  const workspaceDir = path.join(homeDir, 'workspace')
  const browserProfilesDir = path.join(homeDir, 'browser-profiles')
  const nextInstall = resolveInstalledNext(pkgRoot)
  const nextCliPath = nextInstall?.nextCli || path.join(pkgRoot, 'node_modules', 'next', 'dist', 'bin', 'next')
  const standaloneServer = findStandaloneServer({ pkgRoot })
  const buildRoot = resolvePackageBuildRoot(pkgRoot)
  const pid = readPid(pidFile)
  const running = pid ? isProcessRunning(pid) : false

  const serverState = !pid
    ? 'not-running'
    : running
      ? 'running'
      : 'stale-pid'

  const recommendations = []
  if (!standaloneServer) {
    if (fs.existsSync(nextCliPath)) {
      recommendations.push('Standalone bundle is missing. Run `swarmclaw run` to build it automatically or `swarmclaw server --build` to prebuild it now.')
    } else {
      recommendations.push('Next.js build dependencies are missing from this install. Reinstall the package before starting SwarmClaw.')
    }
  }
  if (serverState === 'stale-pid') {
    recommendations.push('A stale PID file was found. Run `swarmclaw stop` to clean it up.')
  }

  return {
    packageVersion: readPackageVersion(pkgRoot) || 'unknown',
    packageRoot: pkgRoot,
    buildRoot,
    installKind: isGitCheckout(pkgRoot) ? 'git' : 'package',
    homeDir,
    dataDir,
    workspaceDir,
    browserProfilesDir,
    server: {
      state: serverState,
      pid,
      pidFile,
    },
    build: {
      standaloneServer,
      nextCliPresent: fs.existsSync(nextCliPath),
      nextCliPath,
    },
    recommendations,
  }
}

function printHelp() {
  process.stdout.write(`
Usage: swarmclaw doctor [--json]

Show local installation and build diagnostics for SwarmClaw.
`.trim() + '\n')
}

function printHumanReport(report) {
  const lines = [
    `Package version: ${report.packageVersion}`,
    `Install kind: ${report.installKind}`,
    `Package root: ${report.packageRoot}`,
    `Build root: ${report.buildRoot}`,
    `Home: ${report.homeDir}`,
    `Data: ${report.dataDir}`,
    `Workspace: ${report.workspaceDir}`,
    `Browser profiles: ${report.browserProfilesDir}`,
    `Server: ${report.server.state}${report.server.pid ? ` (PID: ${report.server.pid})` : ''}`,
    `Standalone bundle: ${report.build.standaloneServer ? `yes (${report.build.standaloneServer})` : 'no'}`,
    `Next CLI available: ${report.build.nextCliPresent ? 'yes' : 'no'}`,
  ]

  if (report.recommendations.length > 0) {
    lines.push('', 'Recommendations:')
    for (const recommendation of report.recommendations) {
      lines.push(`- ${recommendation}`)
    }
  }

  process.stdout.write(`${lines.join('\n')}\n`)
}

function main(args = process.argv.slice(3)) {
  const json = args.includes('--json')
  if (args.includes('-h') || args.includes('--help')) {
    printHelp()
    process.exit(0)
  }

  const unknown = args.filter((arg) => arg !== '--json')
  if (unknown.length > 0) {
    process.stderr.write(`[swarmclaw] Unknown argument: ${unknown[0]}\n`)
    printHelp()
    process.exit(1)
  }

  const report = buildDoctorReport()
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  printHumanReport(report)
}

if (require.main === module) {
  main()
}

module.exports = {
  buildDoctorReport,
  isProcessRunning,
  main,
  readPid,
}
