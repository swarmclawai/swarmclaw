import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
}

let tempDir = ''
let integrityMonitor: typeof import('./integrity-monitor')

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-integrity-'))
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = path.join(tempDir, 'workspace')
  process.env.SWARMCLAW_BUILD_MODE = '1'
  integrityMonitor = await import('./integrity-monitor')
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('integrity-monitor', () => {
  it('returns disabled result when integrityMonitorEnabled is false', () => {
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: false })
    assert.equal(result.enabled, false)
    assert.equal(result.checkedFiles, 0)
    assert.equal(result.drifts.length, 0)
    assert.ok(result.checkedAt > 0)
  })

  it('returns disabled for string "false"', () => {
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: 'false' })
    assert.equal(result.enabled, false)
  })

  it('returns disabled for string "0"', () => {
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: '0' })
    assert.equal(result.enabled, false)
  })

  it('returns disabled for string "off"', () => {
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: 'off' })
    assert.equal(result.enabled, false)
  })

  it('defaults to enabled when setting is null', () => {
    const result = integrityMonitor.runIntegrityMonitor(null)
    assert.equal(result.enabled, true)
    assert.ok(result.checkedAt > 0)
  })

  it('defaults to enabled when setting is undefined', () => {
    const result = integrityMonitor.runIntegrityMonitor()
    assert.equal(result.enabled, true)
  })

  it('enabled with string "true"', () => {
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: 'true' })
    assert.equal(result.enabled, true)
  })

  it('enabled with string "1"', () => {
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: '1' })
    assert.equal(result.enabled, true)
  })

  it('enabled run returns result with checkedFiles and drifts array', () => {
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    assert.equal(result.enabled, true)
    assert.ok(typeof result.checkedFiles === 'number')
    assert.ok(Array.isArray(result.drifts))
    assert.ok(result.checkedAt > 0)
  })

  it('second run with no changes produces zero drifts', () => {
    // First run establishes baselines
    integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    // Second run with no changes
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    assert.equal(result.drifts.length, 0)
  })

  it('detects file modification as drift', () => {
    // Create a plugin file in the data/plugins dir
    const pluginDir = path.join(process.env.DATA_DIR!, 'plugins')
    fs.mkdirSync(pluginDir, { recursive: true })
    const pluginFile = path.join(pluginDir, 'test-integrity-plugin.js')
    fs.writeFileSync(pluginFile, 'module.exports = { name: "test" }')

    // First run: baseline
    integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })

    // Modify the file
    fs.writeFileSync(pluginFile, 'module.exports = { name: "modified" }')

    // Second run: should detect drift
    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    const drift = result.drifts.find((d) => d.filePath === path.resolve(pluginFile))
    assert.ok(drift, 'should detect modified plugin file')
    assert.equal(drift!.type, 'modified')
    assert.ok(drift!.previousHash)
    assert.ok(drift!.nextHash)
    assert.notEqual(drift!.previousHash, drift!.nextHash)
  })

  it('deleted plugin file is no longer in watch targets (no drift)', () => {
    // pushIfExists skips non-existent files, so deletion means the file
    // simply drops out of the watch targets — no drift is generated.
    const pluginDir = path.join(process.env.DATA_DIR!, 'plugins')
    fs.mkdirSync(pluginDir, { recursive: true })
    const pluginFile = path.join(pluginDir, 'test-delete-plugin.js')
    fs.writeFileSync(pluginFile, 'module.exports = {}')

    // Baseline
    integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })

    // Delete
    fs.unlinkSync(pluginFile)

    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    const drift = result.drifts.find((d) => d.filePath === path.resolve(pluginFile))
    assert.equal(drift, undefined, 'deleted file should not appear as drift')
  })

  it('new plugin file is baselined without drift on first run', () => {
    const pluginDir = path.join(process.env.DATA_DIR!, 'plugins')
    fs.mkdirSync(pluginDir, { recursive: true })
    const pluginFile = path.join(pluginDir, 'brand-new-plugin.js')
    fs.writeFileSync(pluginFile, 'module.exports = { name: "new" }')

    const result = integrityMonitor.runIntegrityMonitor({ integrityMonitorEnabled: true })
    // First time seeing the file — establishes baseline, no drift
    const drift = result.drifts.find((d) => d.filePath === path.resolve(pluginFile))
    assert.equal(drift, undefined, 'new file on first run should not produce drift')
    assert.ok(result.checkedFiles > 0)
  })
})
