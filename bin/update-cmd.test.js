'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { runRegistrySelfUpdate } = require('./update-cmd.js')

test('runRegistrySelfUpdate executes the manager-specific global update command and rebuilds the standalone server', () => {
  const messages = []
  const captured = []

  const exitCode = runRegistrySelfUpdate(
    'pnpm',
    (command, args, options) => {
      captured.push({ command, args, options })
    },
    {
      log: (message) => messages.push(`log:${message}`),
      logError: (message) => messages.push(`err:${message}`),
    },
    (command, args, options) => {
      captured.push({ command, args, options })
    },
  )

  assert.equal(exitCode, 0)
  assert.deepEqual(captured, [
    {
      command: 'pnpm',
      args: ['add', '-g', '@swarmclawai/swarmclaw@latest'],
      options: {
        cwd: process.cwd(),
        stdio: 'inherit',
        timeout: 120_000,
      },
    },
    {
      command: process.execPath,
      args: [path.join(process.cwd(), 'bin', 'server-cmd.js'), '--build'],
      options: {
        cwd: process.cwd(),
        stdio: 'inherit',
        timeout: 600_000,
      },
    },
  ])
  assert.match(messages.join('\n'), /updating the global @swarmclawai\/swarmclaw install via pnpm/i)
  assert.match(messages.join('\n'), /global update complete via pnpm/i)
  assert.match(messages.join('\n'), /rebuilding the standalone server bundle/i)
  assert.match(messages.join('\n'), /standalone server bundle rebuilt/i)
})

test('runRegistrySelfUpdate reports a manual retry command when the registry update fails', () => {
  const messages = []

  const exitCode = runRegistrySelfUpdate(
    'bun',
    () => {
      throw new Error('spawn bun ENOENT')
    },
    {
      log: (message) => messages.push(`log:${message}`),
      logError: (message) => messages.push(`err:${message}`),
    },
  )

  assert.equal(exitCode, 1)
  assert.match(messages.join('\n'), /registry update failed: spawn bun ENOENT/i)
  assert.match(messages.join('\n'), /retry manually with: bun add -g @swarmclawai\/swarmclaw@latest/i)
})

test('runRegistrySelfUpdate reports a manual rebuild command when the rebuild step fails', () => {
  const messages = []

  const exitCode = runRegistrySelfUpdate(
    'npm',
    () => {},
    {
      log: (message) => messages.push(`log:${message}`),
      logError: (message) => messages.push(`err:${message}`),
    },
    () => {
      throw new Error('build failed')
    },
  )

  assert.equal(exitCode, 1)
  assert.match(messages.join('\n'), /standalone rebuild failed: build failed/i)
  assert.match(messages.join('\n'), /retry manually with: swarmclaw server --build/i)
})
