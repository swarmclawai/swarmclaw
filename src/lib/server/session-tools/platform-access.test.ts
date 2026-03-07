import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { ToolBuildContext } from './context'
import { buildPlatformTools } from './platform'
import { loadSettings, saveSettings } from '../storage'

const originalSettings = loadSettings()

afterEach(() => {
  saveSettings(originalSettings)
})

function buildTestContext(hasPlugin: (name: string) => boolean): ToolBuildContext {
  return {
    cwd: process.cwd(),
    ctx: undefined,
    hasPlugin,
    hasTool: hasPlugin,
    cleanupFns: [],
    commandTimeoutMs: 1_000,
    claudeTimeoutMs: 1_000,
    cliProcessTimeoutMs: 1_000,
    persistDelegateResumeId: () => {},
    readStoredDelegateResumeId: () => null,
    resolveCurrentSession: () => null,
    activePlugins: ['manage_platform'],
  }
}

describe('buildPlatformTools', () => {
  it('blocks task resources when task management is disabled', async () => {
    saveSettings({
      ...originalSettings,
      taskManagementEnabled: false,
      projectManagementEnabled: true,
    })

    const [toolEntry] = buildPlatformTools(buildTestContext((name) => name === 'manage_platform'))
    assert.ok(toolEntry)

    const result = await toolEntry.invoke({ resource: 'tasks', action: 'list' })
    assert.match(String(result), /task management is disabled/i)
  })

  it('allows project resources through manage_platform when project management is enabled', async () => {
    saveSettings({
      ...originalSettings,
      taskManagementEnabled: true,
      projectManagementEnabled: true,
    })

    const [toolEntry] = buildPlatformTools(buildTestContext((name) => name === 'manage_platform'))
    assert.ok(toolEntry)

    const result = await toolEntry.invoke({ resource: 'projects', action: 'list' })
    assert.doesNotMatch(String(result), /unknown resource|disabled/i)
  })
})
