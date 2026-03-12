'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { buildDoctorReport } = require('./doctor-cmd.js')

test('buildDoctorReport recommends a local build when standalone output is missing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-doctor-'))
  const pkgRoot = path.join(tempDir, 'pkg')
  const homeDir = path.join(tempDir, '.swarmclaw')
  const nextCli = path.join(pkgRoot, 'node_modules', 'next', 'dist', 'bin', 'next')

  fs.mkdirSync(path.dirname(nextCli), { recursive: true })
  fs.mkdirSync(homeDir, { recursive: true })
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: '@swarmclawai/swarmclaw', version: '1.0.1' }), 'utf8')
  fs.writeFileSync(nextCli, '#!/usr/bin/env node\n', 'utf8')

  const report = buildDoctorReport({ pkgRoot, homeDir })

  assert.equal(report.installKind, 'package')
  assert.equal(report.build.nextCliPresent, true)
  assert.equal(report.build.standaloneServer, null)
  assert.match(report.recommendations.join('\n'), /swarmclaw run/)

  fs.rmSync(tempDir, { recursive: true, force: true })
})

test('buildDoctorReport flags stale PID files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-doctor-stale-'))
  const pkgRoot = path.join(tempDir, 'pkg')
  const homeDir = path.join(tempDir, '.swarmclaw')
  const pidFile = path.join(homeDir, 'server.pid')

  fs.mkdirSync(homeDir, { recursive: true })
  fs.mkdirSync(pkgRoot, { recursive: true })
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: '@swarmclawai/swarmclaw', version: '1.0.1' }), 'utf8')
  fs.writeFileSync(pidFile, '999999\n', 'utf8')

  const report = buildDoctorReport({ pkgRoot, homeDir })

  assert.equal(report.server.state, 'stale-pid')
  assert.match(report.recommendations.join('\n'), /swarmclaw stop/)

  fs.rmSync(tempDir, { recursive: true, force: true })
})
