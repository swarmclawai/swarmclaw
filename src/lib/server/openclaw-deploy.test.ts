import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildOpenClawDeployBundle,
  getOpenClawLocalDeployStatus,
} from './openclaw-deploy.ts'

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

  assert.equal(status.running, false)
  assert.equal(status.port, 18789)
  assert.equal(status.endpoint, 'http://127.0.0.1:18789/v1')
  assert.equal(status.wsUrl, 'ws://127.0.0.1:18789')
  assert.match(status.launchCommand, /npx openclaw gateway run/)
})
