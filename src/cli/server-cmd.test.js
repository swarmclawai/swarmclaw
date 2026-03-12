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

test('resolvePackageBuildRoot uses a versioned workspace for registry installs', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-home-'))
  const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-pkg-'))
  const serverCmd = loadServerCmdForHome(homeDir)

  fs.writeFileSync(
    path.join(pkgRoot, 'package.json'),
    JSON.stringify({ name: '@swarmclawai/swarmclaw', version: '1.0.2' }),
    'utf8',
  )

  assert.equal(
    serverCmd.resolvePackageBuildRoot(pkgRoot),
    path.join(homeDir, 'builds', 'package-1.0.2'),
  )

  fs.rmSync(homeDir, { recursive: true, force: true })
  fs.rmSync(pkgRoot, { recursive: true, force: true })
})

test('findStandaloneServer falls back to the external build workspace for registry installs', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-home-'))
  const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-pkg-'))
  const serverCmd = loadServerCmdForHome(homeDir)

  fs.writeFileSync(
    path.join(pkgRoot, 'package.json'),
    JSON.stringify({ name: '@swarmclawai/swarmclaw', version: '1.0.2' }),
    'utf8',
  )

  const nestedServer = path.join(
    serverCmd.resolvePackageBuildRoot(pkgRoot),
    '.next',
    'standalone',
    'Users',
    'wayde',
    'Dev',
    'swarmclaw',
    'server.js',
  )
  fs.mkdirSync(path.dirname(nestedServer), { recursive: true })
  fs.writeFileSync(nestedServer, 'console.log("ok")\n', 'utf8')

  assert.equal(serverCmd.findStandaloneServer({ pkgRoot }), nestedServer)

  fs.rmSync(homeDir, { recursive: true, force: true })
  fs.rmSync(pkgRoot, { recursive: true, force: true })
})

test('prepareBuildWorkspace copies the package tree and links node_modules outside node_modules paths', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-home-'))
  const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-pkg-'))
  const externalNodeModules = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-node-modules-'))
  const serverCmd = loadServerCmdForHome(homeDir)

  fs.writeFileSync(
    path.join(pkgRoot, 'package.json'),
    JSON.stringify({ name: '@swarmclawai/swarmclaw', version: '1.0.2' }),
    'utf8',
  )
  fs.mkdirSync(path.join(pkgRoot, 'src', 'app'), { recursive: true })
  fs.writeFileSync(path.join(pkgRoot, 'src', 'app', 'page.tsx'), 'export default function Page() { return null }\n', 'utf8')

  const buildRoot = serverCmd.resolvePackageBuildRoot(pkgRoot)
  serverCmd.prepareBuildWorkspace({ pkgRoot, buildRoot, nodeModulesDir: externalNodeModules })

  assert.equal(fs.readFileSync(path.join(buildRoot, 'package.json'), 'utf8'), fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'))
  assert.equal(fs.readFileSync(path.join(buildRoot, 'src', 'app', 'page.tsx'), 'utf8'), 'export default function Page() { return null }\n')
  assert.equal(fs.lstatSync(path.join(buildRoot, 'node_modules')).isSymbolicLink(), true)
  assert.equal(fs.realpathSync(path.join(buildRoot, 'node_modules')), fs.realpathSync(externalNodeModules))

  fs.rmSync(homeDir, { recursive: true, force: true })
  fs.rmSync(pkgRoot, { recursive: true, force: true })
  fs.rmSync(externalNodeModules, { recursive: true, force: true })
})

test('resolveReadyCheckHost maps wildcard bind hosts to loopback', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-home-'))
  const serverCmd = loadServerCmdForHome(homeDir)

  assert.equal(serverCmd.resolveReadyCheckHost('0.0.0.0'), '127.0.0.1')
  assert.equal(serverCmd.resolveReadyCheckHost('::'), '::1')
  assert.equal(serverCmd.resolveReadyCheckHost('127.0.0.1'), '127.0.0.1')

  fs.rmSync(homeDir, { recursive: true, force: true })
})

test('waitForPortReady resolves once the readiness probe succeeds', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-home-'))
  const serverCmd = loadServerCmdForHome(homeDir)
  const calls = []
  let attempts = 0

  await serverCmd.waitForPortReady({
    host: '0.0.0.0',
    port: 3456,
    timeoutMs: 1_000,
    intervalMs: 10,
    probeFn: async (host, port) => {
      calls.push({ host, port })
      attempts += 1
      return attempts >= 3
    },
  })

  assert.deepEqual(calls[0], { host: '127.0.0.1', port: 3456 })
  assert.equal(calls.length, 3)
  fs.rmSync(homeDir, { recursive: true, force: true })
})

test('waitForPortReady fails fast when the detached process exits before readiness', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-server-home-'))
  const serverCmd = loadServerCmdForHome(homeDir)

  await assert.rejects(
    serverCmd.waitForPortReady({
      host: '127.0.0.1',
      port: 6553,
      pid: 4242,
      timeoutMs: 500,
      intervalMs: 25,
      isProcessRunningFn: () => false,
    }),
    /exited before becoming ready/,
  )

  fs.rmSync(homeDir, { recursive: true, force: true })
})
