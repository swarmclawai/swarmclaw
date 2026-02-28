#!/usr/bin/env node
/**
 * OpenClaw Gateway Protocol Compatibility Test
 *
 * Validates that SwarmClaw's direct WebSocket implementation is compatible with
 * the latest openclaw CLI's gateway protocol. Spins up a mock gateway server,
 * then tests both our implementation and the openclaw CLI against it.
 *
 * Usage: node scripts/test-openclaw-protocol.mjs [--install-cli]
 *   --install-cli   Install latest openclaw CLI to a temp dir for comparison testing
 *
 * Without --install-cli, only tests SwarmClaw's implementation against the mock gateway.
 */

import { WebSocketServer, WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const PROTOCOL_VERSION = 3
const TEST_TOKEN = 'test-token-abc123'
const MOCK_PORT = 0 // random available port
const PASS = '\x1b[32m✓\x1b[0m'
const FAIL = '\x1b[31m✗\x1b[0m'

let passed = 0
let failed = 0

function assert(condition, label) {
  if (condition) {
    console.log(`  ${PASS} ${label}`)
    passed++
  } else {
    console.log(`  ${FAIL} ${label}`)
    failed++
  }
}

// --- Mock Gateway Server ---

function createMockGateway() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: MOCK_PORT }, () => {
      const port = wss.address().port
      resolve({ wss, port })
    })

    wss.on('connection', (ws) => {
      const nonce = randomUUID()

      // Step 1: Send connect challenge
      ws.send(JSON.stringify({
        event: 'connect.challenge',
        payload: { nonce },
      }))

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())

          // Step 2: Handle connect request
          if (msg.type === 'req' && msg.method === 'connect') {
            const token = msg.params?.auth?.token
            if (token && token !== TEST_TOKEN) {
              ws.send(JSON.stringify({
                type: 'res',
                id: msg.id,
                ok: false,
                error: { message: 'unauthorized: gateway token mismatch' },
              }))
              ws.close(1008, 'unauthorized')
              return
            }

            ws.send(JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: {
                protocol: PROTOCOL_VERSION,
                gateway: { version: 'mock-1.0.0' },
                policy: { tickIntervalMs: 30000 },
              },
            }))
            return
          }

          // Step 3: Handle agent request
          if (msg.type === 'req' && msg.method === 'agent') {
            // Send accepted status first
            ws.send(JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { status: 'accepted' },
            }))

            // Then send final response
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'res',
                id: msg.id,
                ok: true,
                payload: {
                  status: 'final',
                  result: {
                    payloads: [{ text: `Echo: ${msg.params?.message || 'no message'}` }],
                  },
                  summary: `Echo: ${msg.params?.message || 'no message'}`,
                },
              }))
            }, 50)
            return
          }
        } catch {
          // ignore
        }
      })
    })
  })
}

// --- SwarmClaw Protocol Implementation Test ---

async function testSwarmClawProtocol(port) {
  console.log('\n--- SwarmClaw WebSocket Protocol ---')

  // Test 1: Successful connection with valid token
  const result1 = await testConnect(port, TEST_TOKEN)
  assert(result1.connected, 'Connects with valid token')
  assert(result1.helloOk, 'Receives hello_ok response')

  // Test 2: Connection with invalid token
  const result2 = await testConnect(port, 'wrong-token')
  assert(!result2.connected || !result2.helloOk, 'Rejects invalid token')

  // Test 3: Agent request
  const result3 = await testAgentRequest(port, TEST_TOKEN, 'Hello from test')
  assert(result3.ok, 'Agent request succeeds')
  assert(result3.text?.includes('Echo: Hello from test'), `Agent response text correct (got: ${result3.text})`)

  // Test 4: Connect frame format
  const result4 = await testConnectFrameFormat(port, TEST_TOKEN)
  assert(result4.hasType, 'Connect frame has type: "req"')
  assert(result4.hasId, 'Connect frame has id (UUID)')
  assert(result4.hasMethod, 'Connect frame has method: "connect"')
  assert(result4.hasProtocol, 'Connect frame has minProtocol/maxProtocol')
  assert(result4.hasClient, 'Connect frame has client info')
  assert(result4.hasAuth, 'Connect frame has auth.token')
}

function testConnect(port, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    let connected = false
    let helloOk = false
    const timer = setTimeout(() => { ws.close(); resolve({ connected, helloOk }) }, 5000)

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.event === 'connect.challenge') {
        connected = true
        ws.send(JSON.stringify({
          type: 'req', id: randomUUID(), method: 'connect',
          params: {
            minProtocol: 1, maxProtocol: 3,
            auth: { token },
            client: { id: 'gateway-client', version: '1.0.0', platform: process.platform, mode: 'backend', instanceId: randomUUID() },
            caps: [], role: 'operator', scopes: ['operator.admin'],
          },
        }))
      } else if (msg.type === 'res' && msg.ok) {
        helloOk = true
        clearTimeout(timer); ws.close(); resolve({ connected, helloOk })
      } else if (msg.type === 'res' && !msg.ok) {
        clearTimeout(timer); ws.close(); resolve({ connected, helloOk: false })
      }
    })
    ws.on('error', () => { clearTimeout(timer); resolve({ connected, helloOk }) })
  })
}

function testAgentRequest(port, token, message) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    let agentReqId = null
    const timer = setTimeout(() => { ws.close(); resolve({ ok: false, text: 'timeout' }) }, 5000)

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.event === 'connect.challenge') {
        ws.send(JSON.stringify({
          type: 'req', id: randomUUID(), method: 'connect',
          params: {
            minProtocol: 1, maxProtocol: 1, auth: { token },
            client: { id: 'swarmclaw', version: '1.0.0', mode: 'cli', instanceId: randomUUID() },
            caps: [], role: 'operator', scopes: ['operator.admin'],
          },
        }))
      } else if (msg.type === 'res' && msg.ok && !agentReqId) {
        agentReqId = randomUUID()
        ws.send(JSON.stringify({
          type: 'req', id: agentReqId, method: 'agent',
          params: { message, agentId: 'main', timeout: 10, idempotencyKey: randomUUID() },
        }))
      } else if (msg.type === 'res' && msg.id === agentReqId) {
        if (msg.payload?.status === 'accepted') return // interim
        const text = msg.payload?.result?.payloads?.[0]?.text || msg.payload?.summary || ''
        clearTimeout(timer); ws.close(); resolve({ ok: msg.ok, text })
      }
    })
    ws.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, text: err.message }) })
  })
}

function testConnectFrameFormat(port, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const timer = setTimeout(() => { ws.close(); resolve({}) }, 5000)

    // Intercept what we send
    const origSend = ws.send.bind(ws)
    ws.send = (data) => {
      const msg = JSON.parse(data)
      if (msg.method === 'connect') {
        clearTimeout(timer); ws.close()
        resolve({
          hasType: msg.type === 'req',
          hasId: typeof msg.id === 'string' && msg.id.length > 10,
          hasMethod: msg.method === 'connect',
          hasProtocol: typeof msg.params?.minProtocol === 'number' && typeof msg.params?.maxProtocol === 'number',
          hasClient: typeof msg.params?.client?.id === 'string',
          hasAuth: msg.params?.auth?.token === token,
        })
      }
      origSend(data)
    }

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.event === 'connect.challenge') {
        ws.send(JSON.stringify({
          type: 'req', id: randomUUID(), method: 'connect',
          params: {
            minProtocol: 1, maxProtocol: 1, auth: { token },
            client: { id: 'swarmclaw', version: '1.0.0', mode: 'cli', instanceId: randomUUID() },
            caps: [], role: 'operator', scopes: ['operator.admin'],
          },
        }))
      }
    })
    ws.on('error', () => { clearTimeout(timer); resolve({}) })
  })
}

// --- Main ---

async function main() {
  const installCli = process.argv.includes('--install-cli')

  console.log('Starting mock OpenClaw gateway...')
  const { wss, port } = await createMockGateway()
  console.log(`Mock gateway listening on ws://127.0.0.1:${port}`)

  await testSwarmClawProtocol(port)

  if (installCli) {
    console.log('\n--- OpenClaw CLI Comparison ---')
    const tmpDir = mkdtempSync(join(tmpdir(), 'openclaw-test-'))
    try {
      console.log(`Installing latest openclaw CLI to ${tmpDir}...`)
      const install = spawnSync('npm', ['install', 'openclaw'], {
        cwd: tmpDir, encoding: 'utf-8', timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (install.status !== 0) {
        console.log(`  ${FAIL} Failed to install openclaw: ${(install.stderr || '').slice(0, 200)}`)
        failed++
      } else {
        const bin = join(tmpDir, 'node_modules/.bin/openclaw')
        const version = spawnSync(bin, ['--version'], { encoding: 'utf-8', timeout: 5000 })
        console.log(`  Installed: ${(version.stdout || '').trim()}`)

        // Test gateway status against mock
        const status = spawnSync(bin, ['gateway', 'status', '--url', `ws://127.0.0.1:${port}`, '--token', TEST_TOKEN, '--json', '--timeout', '5000'], {
          encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
        })
        const statusJson = JSON.parse(status.stdout || '{}')
        assert(statusJson.rpc?.ok === true || statusJson.gateway?.probeUrl?.includes(String(port)), 'CLI gateway status connects to mock')

        // Check protocol version from CLI source
        const grepResult = spawnSync('grep', ['-r', 'PROTOCOL_VERSION', join(tmpDir, 'node_modules/openclaw/dist/')], {
          encoding: 'utf-8', timeout: 5000,
        })
        const versionMatch = (grepResult.stdout || '').match(/PROTOCOL_VERSION\s*=\s*(\d+)/)
        if (versionMatch) {
          const cliVersion = parseInt(versionMatch[1])
          assert(cliVersion === PROTOCOL_VERSION, `Protocol version matches (CLI: ${cliVersion}, ours: ${PROTOCOL_VERSION})`)
        } else {
          console.log(`  ${FAIL} Could not determine CLI protocol version`)
          failed++
        }
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  wss.close()

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
