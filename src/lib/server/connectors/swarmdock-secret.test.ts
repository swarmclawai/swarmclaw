import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-swarmdock-secret-'))
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

test('createConnector stores SwarmDock private keys as credentials and redacts config output', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('./src/lib/server/storage')
    const serviceMod = await import('./src/lib/server/connectors/connector-service')
    const secretMod = await import('./src/lib/server/connectors/swarmdock-secret')
    const storage = storageMod.default || storageMod
    const service = serviceMod.default || serviceMod
    const secret = secretMod.default || secretMod

    const created = service.createConnector({
      name: 'SwarmDock Worker',
      platform: 'swarmdock',
      config: {
        apiUrl: 'https://api.swarmdock.example',
        walletAddress: '0x000000000000000000000000000000000000dEaD',
        privateKey: 'legacy-private-key',
      },
    })

    const stored = storage.loadConnectors()[created.id]
    const credentials = storage.loadCredentials()
    const credential = stored?.credentialId ? credentials[stored.credentialId] : null
    const redacted = secret.redactConnectorSecrets({
      ...stored,
      config: {
        ...(stored?.config || {}),
        privateKey: 'should-not-leak',
      },
    })

    console.log(JSON.stringify({
      credentialId: stored?.credentialId || null,
      storedHasPrivateKey: Boolean(stored?.config && Object.prototype.hasOwnProperty.call(stored.config, 'privateKey')),
      credentialProvider: credential?.provider || null,
      credentialName: credential?.name || null,
      redactedHasPrivateKey: Boolean(redacted?.config && Object.prototype.hasOwnProperty.call(redacted.config, 'privateKey')),
    }))
  `)

  assert.match(String(output.credentialId || ''), /^cred_/)
  assert.equal(output.storedHasPrivateKey, false)
  assert.equal(output.credentialProvider, 'swarmdock')
  assert.match(String(output.credentialName || ''), /SwarmDock Identity Key/)
  assert.equal(output.redactedHasPrivateKey, false)
})

test('ensureSwarmdockConnectorCredential migrates stored legacy config keys into credentials', () => {
  const output = runWithTempDataDir(`
    const storageMod = await import('./src/lib/server/storage')
    const repoMod = await import('./src/lib/server/connectors/connector-repository')
    const secretMod = await import('./src/lib/server/connectors/swarmdock-secret')
    const storage = storageMod.default || storageMod
    const repo = repoMod.default || repoMod
    const secret = secretMod.default || secretMod

    storage.saveConnectors({
      conn_legacy: {
        id: 'conn_legacy',
        name: 'Legacy SwarmDock',
        platform: 'swarmdock',
        agentId: null,
        chatroomId: null,
        credentialId: null,
        config: {
          walletAddress: '0x000000000000000000000000000000000000dEaD',
          privateKey: 'legacy-private-key',
        },
        isEnabled: false,
        status: 'stopped',
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
      },
    })

    const prepared = secret.ensureSwarmdockConnectorCredential(repo.loadConnector('conn_legacy'))
    const migrated = repo.loadConnector('conn_legacy')
    const credentials = storage.loadCredentials()
    const credential = migrated?.credentialId ? credentials[migrated.credentialId] : null

    console.log(JSON.stringify({
      fallbackPrivateKey: prepared.fallbackPrivateKey,
      migratedCredentialId: migrated?.credentialId || null,
      migratedHasPrivateKey: Boolean(migrated?.config && Object.prototype.hasOwnProperty.call(migrated.config, 'privateKey')),
      credentialProvider: credential?.provider || null,
    }))
  `)

  assert.equal(output.fallbackPrivateKey, null)
  assert.match(String(output.migratedCredentialId || ''), /^cred_/)
  assert.equal(output.migratedHasPrivateKey, false)
  assert.equal(output.credentialProvider, 'swarmdock')
})
