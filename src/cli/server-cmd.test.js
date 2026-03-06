'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function loadServerCmdForHome(homeDir) {
  const modPath = require.resolve('../../bin/server-cmd.js')
  const previousHome = process.env.SWARMCLAW_HOME
  process.env.SWARMCLAW_HOME = homeDir
  delete require.cache[modPath]
  const loaded = require(modPath)
  if (previousHome === undefined) delete process.env.SWARMCLAW_HOME
  else process.env.SWARMCLAW_HOME = previousHome
  delete require.cache[modPath]
  return loaded
}

test('needsBuild returns true when no build marker exists', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-home-'))
  const serverCmd = loadServerCmdForHome(homeDir)
  assert.equal(serverCmd.needsBuild(false), true)
  fs.rmSync(homeDir, { recursive: true, force: true })
})

test('needsBuild returns false when build marker version matches and standalone server exists', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-home-'))
  const serverCmd = loadServerCmdForHome(homeDir)

  fs.mkdirSync(path.join(homeDir, '.next', 'standalone'), { recursive: true })
  fs.writeFileSync(path.join(homeDir, '.next', 'standalone', 'server.js'), 'console.log("ok")\n', 'utf8')
  fs.writeFileSync(
    path.join(homeDir, '.built'),
    JSON.stringify({ builtAt: new Date().toISOString(), version: serverCmd.getVersion() }),
    'utf8',
  )

  assert.equal(serverCmd.needsBuild(false), false)
  fs.rmSync(homeDir, { recursive: true, force: true })
})

test('needsBuild returns true when build marker version is stale', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-home-'))
  const serverCmd = loadServerCmdForHome(homeDir)

  fs.mkdirSync(path.join(homeDir, '.next', 'standalone'), { recursive: true })
  fs.writeFileSync(path.join(homeDir, '.next', 'standalone', 'server.js'), 'console.log("ok")\n', 'utf8')
  fs.writeFileSync(
    path.join(homeDir, '.built'),
    JSON.stringify({ builtAt: new Date().toISOString(), version: '0.0.0-test' }),
    'utf8',
  )

  assert.equal(serverCmd.needsBuild(false), true)
  fs.rmSync(homeDir, { recursive: true, force: true })
})
