import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-wallet-routes-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CREDENTIAL_SECRET: 'test-credential-secret',
        DATA_DIR: path.join(tempDir, 'data'),
        WORKSPACE_DIR: path.join(tempDir, 'workspace'),
      },
      encoding: 'utf-8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
    const lines = (result.stdout || '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'))
    return JSON.parse(jsonLine || '{}')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

test('wallet routes reject unknown agents and invalid addresses while returning safe payloads', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('./src/lib/server/storage')
    const walletsRouteMod = await import('./src/app/api/wallets/route')
    const walletsGenerateRouteMod = await import('./src/app/api/wallets/generate/route')
    const storage = storageMod.default || storageMod
    const walletsRoute = walletsRouteMod.default || walletsRouteMod
    const walletsGenerateRoute = walletsGenerateRouteMod.default || walletsGenerateRouteMod

    storage.saveAgents({
      agent_1: {
        id: 'agent_1',
        name: 'Agent One',
      },
    })

    const missingAgentResponse = await walletsRoute.POST(new Request('http://local/api/wallets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'missing-agent',
        walletAddress: '0x000000000000000000000000000000000000dEaD',
      }),
    }))
    const missingAgentPayload = await missingAgentResponse.json()

    const blankAddressResponse = await walletsRoute.POST(new Request('http://local/api/wallets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent_1',
        walletAddress: '   ',
      }),
    }))
    const blankAddressPayload = await blankAddressResponse.json()

    const invalidAddressResponse = await walletsRoute.POST(new Request('http://local/api/wallets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent_1',
        walletAddress: '0x1234',
      }),
    }))
    const invalidAddressPayload = await invalidAddressResponse.json()

    const createResponse = await walletsRoute.POST(new Request('http://local/api/wallets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent_1',
        walletAddress: '0x000000000000000000000000000000000000dead',
        label: 'Manual Wallet',
      }),
    }))
    const createPayload = await createResponse.json()

    const generateMissingResponse = await walletsGenerateRoute.POST(new Request('http://local/api/wallets/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'missing-agent',
      }),
    }))
    const generateMissingPayload = await generateMissingResponse.json()

    const generateResponse = await walletsGenerateRoute.POST(new Request('http://local/api/wallets/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent_1',
        label: 'Generated Wallet',
      }),
    }))
    const generatePayload = await generateResponse.json()

    const storedWallets = Object.values(storage.loadWallets())
    const generatedStoredWallet = storedWallets.find((wallet) => wallet.label === 'Generated Wallet') || null

    console.log(JSON.stringify({
      missingAgentStatus: missingAgentResponse.status,
      missingAgentError: missingAgentPayload?.error || null,
      blankAddressStatus: blankAddressResponse.status,
      blankAddressError: blankAddressPayload?.error || null,
      invalidAddressStatus: invalidAddressResponse.status,
      invalidAddressError: invalidAddressPayload?.error || null,
      createStatus: createResponse.status,
      createAddress: createPayload?.walletAddress || null,
      createHasPrivateKey: Boolean(createPayload && Object.prototype.hasOwnProperty.call(createPayload, 'encryptedPrivateKey')),
      generateMissingStatus: generateMissingResponse.status,
      generateMissingError: generateMissingPayload?.error || null,
      generateStatus: generateResponse.status,
      generateHasPrivateKey: Boolean(generatePayload && Object.prototype.hasOwnProperty.call(generatePayload, 'encryptedPrivateKey')),
      storedGeneratedHasPrivateKey: Boolean(generatedStoredWallet?.encryptedPrivateKey),
    }))
  `)

  assert.equal(output.missingAgentStatus, 404)
  assert.match(String(output.missingAgentError || ''), /Agent not found/i)
  assert.equal(output.blankAddressStatus, 400)
  assert.equal(output.blankAddressError, 'walletAddress is required')
  assert.equal(output.invalidAddressStatus, 400)
  assert.match(String(output.invalidAddressError || ''), /valid Base\/Ethereum address/i)
  assert.equal(output.createStatus, 201)
  assert.equal(output.createAddress, '0x000000000000000000000000000000000000dEaD')
  assert.equal(output.createHasPrivateKey, false)
  assert.equal(output.generateMissingStatus, 404)
  assert.match(String(output.generateMissingError || ''), /Agent not found/i)
  assert.equal(output.generateStatus, 201)
  assert.equal(output.generateHasPrivateKey, false)
  assert.equal(output.storedGeneratedHasPrivateKey, true)
})
