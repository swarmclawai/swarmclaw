import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  buildOpenClawDeployBundle,
  getOpenClawLocalDeployCollectionStatus,
  getOpenClawLocalDeployStatus,
  getOpenClawRemoteDeployCollectionStatus,
  getOpenClawRemoteDeployStatus,
} from './openclaw-deploy'

const GLOBAL_KEY = '__swarmclaw_openclaw_deploy__' as const
const originalRuntimeState = (globalThis as typeof globalThis & { [GLOBAL_KEY]?: unknown })[GLOBAL_KEY]

afterEach(() => {
  ;(globalThis as typeof globalThis & { [GLOBAL_KEY]?: unknown })[GLOBAL_KEY] = originalRuntimeState
})

test('docker smart deploy bundle uses official image and provider-specific metadata', () => {
  const bundle = buildOpenClawDeployBundle({
    template: 'docker',
    provider: 'digitalocean',
    target: 'gateway.example.com',
    token: 'test-token',
  })

  assert.equal(bundle.template, 'docker')
  assert.equal(bundle.provider, 'digitalocean')
  assert.equal(bundle.providerLabel, 'DigitalOcean')
  assert.equal(bundle.endpoint, 'https://gateway.example.com/v1')
  assert.equal(bundle.wsUrl, 'wss://gateway.example.com')
  assert.equal(bundle.useCase, 'single-vps')
  assert.equal(bundle.exposure, 'caddy')
  assert.match(bundle.summary, /official OpenClaw Docker image/i)
  assert.deepEqual(bundle.files.map((file) => file.name), [
    'cloud-init.yaml',
    '.env',
    'docker-compose.yml',
    'bootstrap.sh',
    'docker-compose.proxy.yml',
    'Caddyfile',
  ])

  const envFile = bundle.files.find((file) => file.name === '.env')
  assert.ok(envFile)
  assert.match(envFile.content, /OPENCLAW_IMAGE=openclaw:latest/)
  assert.match(envFile.content, /OPENCLAW_GATEWAY_TOKEN=test-token/)

  const cloudInit = bundle.files.find((file) => file.name === 'cloud-init.yaml')
  assert.ok(cloudInit)
  assert.match(cloudInit.content, /docker\.io/)
  assert.match(cloudInit.content, /docker pull "\$\{OPENCLAW_IMAGE:-openclaw:latest\}"/)
  assert.match(cloudInit.content, /\/opt\/openclaw\/docker-compose\.yml/)

  const caddyfile = bundle.files.find((file) => file.name === 'Caddyfile')
  assert.ok(caddyfile)
  assert.match(caddyfile.content, /gateway\.example\.com/)
})

test('render bundle stays aligned with the official repo flow', () => {
  const bundle = buildOpenClawDeployBundle({
    template: 'render',
    target: 'https://openclaw.onrender.com',
    token: 'render-token',
  })

  assert.equal(bundle.template, 'render')
  assert.equal(bundle.providerLabel, 'Render')
  assert.equal(bundle.endpoint, 'https://openclaw.onrender.com/v1')
  assert.equal(bundle.token, 'render-token')
  assert.deepEqual(bundle.files.map((file) => file.name), [
    'render.yaml',
    'OPENCLAW_GATEWAY_TOKEN.txt',
  ])
  assert.match(bundle.runbook[0] || '', /official OpenClaw GitHub repo/i)
})

test('local deploy status exposes a sensible default endpoint before startup', () => {
  const status = getOpenClawLocalDeployStatus()
  const collection = getOpenClawLocalDeployCollectionStatus()

  assert.equal(status.id, 'local-default')
  assert.equal(status.isPrimary, true)
  assert.equal(status.running, false)
  assert.equal(status.port, 18789)
  assert.equal(status.endpoint, 'http://127.0.0.1:18789/v1')
  assert.equal(status.wsUrl, 'ws://127.0.0.1:18789')
  assert.match(status.launchCommand, /npx openclaw gateway run/)
  assert.equal(collection.primaryId, null)
  assert.deepEqual(collection.items, [])
})

test('remote deploy status exposes a sensible default record before startup', () => {
  const status = getOpenClawRemoteDeployStatus()
  const collection = getOpenClawRemoteDeployCollectionStatus()

  assert.equal(status.id, 'remote-default')
  assert.equal(status.name, 'Remote OpenClaw')
  assert.equal(status.isPrimary, true)
  assert.equal(status.active, false)
  assert.equal(status.status, 'idle')
  assert.equal(status.target, null)
  assert.equal(collection.primaryId, null)
  assert.deepEqual(collection.items, [])
})

test('legacy singleton remote runtime state is migrated into the keyed remote collection', () => {
  ;(globalThis as typeof globalThis & { [GLOBAL_KEY]?: unknown })[GLOBAL_KEY] = {
    locals: {},
    primaryLocalId: null,
    remote: {
      processId: null,
      action: 'ssh-deploy',
      target: 'gateway.example.com',
      startedAt: 123,
      lastError: null,
      lastSummary: 'Deploying OpenClaw to gateway.example.com over SSH.',
      lastCommandPreview: 'ssh root@gateway.example.com ...',
      lastBackupPath: null,
    },
  }

  const status = getOpenClawRemoteDeployStatus()
  const collection = getOpenClawRemoteDeployCollectionStatus()

  assert.equal(status.id, 'remote-default')
  assert.equal(status.name, 'gateway.example.com')
  assert.equal(status.target, 'gateway.example.com')
  assert.equal(status.action, 'ssh-deploy')
  assert.equal(status.lastSummary, 'Deploying OpenClaw to gateway.example.com over SSH.')
  assert.equal(collection.primaryId, 'remote-default')
  assert.equal(collection.items.length, 1)
  assert.equal(collection.items[0]?.id, 'remote-default')
})

test('remote deploy collection preserves multiple remotes and targeted lookup', () => {
  ;(globalThis as typeof globalThis & { [GLOBAL_KEY]?: unknown })[GLOBAL_KEY] = {
    locals: {},
    primaryLocalId: null,
    remotes: {
      'remote-alpha': {
        name: 'alpha',
        processId: null,
        action: 'restart',
        target: 'alpha.example.com',
        startedAt: null,
        createdAt: 10,
        updatedAt: 20,
        lastError: null,
        lastSummary: 'Restarting OpenClaw on alpha.example.com.',
        lastCommandPreview: 'ssh root@alpha.example.com docker compose restart',
        lastBackupPath: null,
      },
      'remote-beta': {
        name: 'beta',
        processId: null,
        action: 'upgrade',
        target: 'beta.example.com',
        startedAt: null,
        createdAt: 30,
        updatedAt: 40,
        lastError: null,
        lastSummary: 'Pulling openclaw:latest and recreating the OpenClaw stack on beta.example.com.',
        lastCommandPreview: 'ssh root@beta.example.com docker compose up -d',
        lastBackupPath: null,
      },
    },
    primaryRemoteId: 'remote-alpha',
  }

  const collection = getOpenClawRemoteDeployCollectionStatus()
  const primary = getOpenClawRemoteDeployStatus()
  const beta = getOpenClawRemoteDeployStatus('remote-beta')

  assert.equal(collection.primaryId, 'remote-alpha')
  assert.equal(collection.items.length, 2)
  assert.equal(collection.items[0]?.id, 'remote-beta')
  assert.equal(collection.items[1]?.id, 'remote-alpha')
  assert.equal(primary.id, 'remote-alpha')
  assert.equal(primary.isPrimary, true)
  assert.equal(beta.id, 'remote-beta')
  assert.equal(beta.target, 'beta.example.com')
  assert.equal(beta.isPrimary, false)
})
