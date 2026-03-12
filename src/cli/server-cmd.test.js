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

test('needsBuild returns true when standalone output is missing from the package root', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-home-'))
  const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-pkg-'))
  const serverCmd = loadServerCmdForHome(homeDir)

  assert.equal(serverCmd.needsBuild(false, { pkgRoot }), true)

  fs.rmSync(homeDir, { recursive: true, force: true })
  fs.rmSync(pkgRoot, { recursive: true, force: true })
})

test('needsBuild returns false when standalone server exists in the package root', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-home-'))
  const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-pkg-'))
  const serverCmd = loadServerCmdForHome(homeDir)

  fs.mkdirSync(path.join(pkgRoot, '.next', 'standalone'), { recursive: true })
  fs.writeFileSync(path.join(pkgRoot, '.next', 'standalone', 'server.js'), 'console.log("ok")\n', 'utf8')

  assert.equal(serverCmd.needsBuild(false, { pkgRoot }), false)

  fs.rmSync(homeDir, { recursive: true, force: true })
  fs.rmSync(pkgRoot, { recursive: true, force: true })
})

test('findStandaloneServer recursively resolves nested standalone server paths', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-home-'))
  const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-pkg-'))
  const serverCmd = loadServerCmdForHome(homeDir)

  const nestedServer = path.join(pkgRoot, '.next', 'standalone', 'Users', 'wayde', 'Dev', 'swarmclaw', 'server.js')
  fs.mkdirSync(path.dirname(nestedServer), { recursive: true })
  fs.writeFileSync(nestedServer, 'console.log("ok")\n', 'utf8')

  assert.equal(serverCmd.findStandaloneServer({ pkgRoot }), nestedServer)

  fs.rmSync(homeDir, { recursive: true, force: true })
  fs.rmSync(pkgRoot, { recursive: true, force: true })
})
