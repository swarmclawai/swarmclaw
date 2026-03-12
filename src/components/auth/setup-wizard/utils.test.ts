import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  stepIndex,
  formatEndpointHost,
  isLocalOpenClawEndpoint,
  resolveOpenClawDashboardUrl,
  getOpenClawErrorHint,
  withHttpScheme,
} from './utils'

// ---------------------------------------------------------------------------
// stepIndex
// ---------------------------------------------------------------------------

test('stepIndex: profile → 0', () => {
  assert.equal(stepIndex('profile'), 0)
})

test('stepIndex: providers → 1', () => {
  assert.equal(stepIndex('providers'), 1)
})

test('stepIndex: connect maps to providers index (1)', () => {
  assert.equal(stepIndex('connect'), 1)
})

test('stepIndex: agents → 2', () => {
  assert.equal(stepIndex('agents'), 2)
})

// ---------------------------------------------------------------------------
// formatEndpointHost
// ---------------------------------------------------------------------------

test('formatEndpointHost extracts host:port', () => {
  assert.equal(formatEndpointHost('http://localhost:18789'), 'localhost:18789')
})

test('formatEndpointHost returns host without port when none specified', () => {
  assert.equal(formatEndpointHost('https://gateway.example.com'), 'gateway.example.com')
})

test('formatEndpointHost returns null for empty', () => {
  assert.equal(formatEndpointHost(''), null)
})

test('formatEndpointHost returns null for null', () => {
  assert.equal(formatEndpointHost(null), null)
})

test('formatEndpointHost adds scheme to bare host:port', () => {
  assert.equal(formatEndpointHost('10.0.0.5:18789'), '10.0.0.5:18789')
})

// ---------------------------------------------------------------------------
// isLocalOpenClawEndpoint
// ---------------------------------------------------------------------------

test('isLocalOpenClawEndpoint: localhost → true', () => {
  assert.equal(isLocalOpenClawEndpoint('http://localhost:18789'), true)
})

test('isLocalOpenClawEndpoint: 127.0.0.1 → true', () => {
  assert.equal(isLocalOpenClawEndpoint('http://127.0.0.1:18789'), true)
})

test('isLocalOpenClawEndpoint: [::1] not matched (URL hostname includes brackets)', () => {
  // URL parser returns hostname as "[::1]", which doesn't match the "::1" check
  assert.equal(isLocalOpenClawEndpoint('http://[::1]:18789'), false)
})

test('isLocalOpenClawEndpoint: remote → false', () => {
  assert.equal(isLocalOpenClawEndpoint('http://gateway.example.com:18789'), false)
})

test('isLocalOpenClawEndpoint: null → false', () => {
  assert.equal(isLocalOpenClawEndpoint(null), false)
})

test('isLocalOpenClawEndpoint: 0.0.0.0 → true', () => {
  assert.equal(isLocalOpenClawEndpoint('http://0.0.0.0:18789'), true)
})

// ---------------------------------------------------------------------------
// resolveOpenClawDashboardUrl
// ---------------------------------------------------------------------------

test('resolveOpenClawDashboardUrl converts ws:// to http://', () => {
  assert.equal(resolveOpenClawDashboardUrl('ws://localhost:18789/v1'), 'http://localhost:18789')
})

test('resolveOpenClawDashboardUrl converts wss:// to https://', () => {
  assert.equal(resolveOpenClawDashboardUrl('wss://gateway.example.com/path'), 'https://gateway.example.com')
})

test('resolveOpenClawDashboardUrl strips path', () => {
  assert.equal(resolveOpenClawDashboardUrl('http://localhost:18789/some/path'), 'http://localhost:18789')
})

test('resolveOpenClawDashboardUrl defaults for null', () => {
  assert.equal(resolveOpenClawDashboardUrl(null), 'http://localhost:18789')
})

// ---------------------------------------------------------------------------
// getOpenClawErrorHint
// ---------------------------------------------------------------------------

test('getOpenClawErrorHint: timeout', () => {
  const hint = getOpenClawErrorHint('Connection timed out')
  assert.ok(hint)
  assert.ok(hint.includes('port'))
})

test('getOpenClawErrorHint: 401', () => {
  const hint = getOpenClawErrorHint('Returned 401 unauthorized')
  assert.ok(hint)
  assert.ok(hint.includes('token'))
})

test('getOpenClawErrorHint: 405', () => {
  const hint = getOpenClawErrorHint('405 Method Not Allowed')
  assert.ok(hint)
  assert.ok(hint.includes('chatCompletions'))
})

test('getOpenClawErrorHint: econnrefused', () => {
  const hint = getOpenClawErrorHint('connect ECONNREFUSED 127.0.0.1:18789')
  assert.ok(hint)
  assert.ok(hint.includes('running'))
})

test('getOpenClawErrorHint: unrecognized error → null', () => {
  assert.equal(getOpenClawErrorHint('something unknown happened'), null)
})

// ---------------------------------------------------------------------------
// withHttpScheme
// ---------------------------------------------------------------------------

test('withHttpScheme adds http:// to bare host', () => {
  assert.equal(withHttpScheme('localhost:18789'), 'http://localhost:18789')
})

test('withHttpScheme preserves existing http://', () => {
  assert.equal(withHttpScheme('http://localhost:18789'), 'http://localhost:18789')
})

test('withHttpScheme preserves existing https://', () => {
  assert.equal(withHttpScheme('https://example.com'), 'https://example.com')
})

test('withHttpScheme preserves ws://', () => {
  assert.equal(withHttpScheme('ws://localhost:18789'), 'ws://localhost:18789')
})

test('withHttpScheme preserves wss://', () => {
  assert.equal(withHttpScheme('wss://example.com'), 'wss://example.com')
})
