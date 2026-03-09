import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { getPluginManager, normalizeMarketplacePluginUrl, sanitizePluginFilename } from './plugins'
import { canonicalizePluginId, expandPluginIds, pluginIdMatches } from './tool-aliases'
import { DATA_DIR } from './data-dir'

let testPluginSeq = 0

function uniquePluginId(prefix: string): string {
  testPluginSeq += 1
  return `${prefix}_${Date.now()}_${testPluginSeq}`
}

describe('plugin id canonicalization', () => {
  it('normalizes built-in aliases to canonical plugin families', () => {
    assert.equal(canonicalizePluginId('session_info'), 'manage_sessions')
    assert.equal(canonicalizePluginId('connectors'), 'manage_connectors')
    assert.equal(canonicalizePluginId('subagent'), 'spawn_subagent')
    assert.equal(canonicalizePluginId('http'), 'http_request')
    assert.equal(canonicalizePluginId('human_loop'), 'ask_human')
    assert.equal(canonicalizePluginId('dataframe'), 'table')
    assert.equal(canonicalizePluginId('extract_structured'), 'extract')
  })

  it('expands aliases to include the canonical family id', () => {
    const expanded = expandPluginIds(['session_info', 'http', 'human_loop'])
    assert.equal(expanded.includes('manage_sessions'), true)
    assert.equal(expanded.includes('session_info'), true)
    assert.equal(expanded.includes('http_request'), true)
    assert.equal(expanded.includes('http'), true)
    assert.equal(expanded.includes('ask_human'), true)
    assert.equal(expanded.includes('human_loop'), true)
  })

  it('does not expand a specific platform tool back into manage_platform', () => {
    const expanded = expandPluginIds(['manage_schedules'])
    assert.equal(expanded.includes('manage_schedules'), true)
    assert.equal(expanded.includes('manage_platform'), false)
    assert.equal(pluginIdMatches(['manage_platform'], 'manage_schedules'), true)
    assert.equal(pluginIdMatches(['manage_schedules'], 'manage_platform'), false)
  })
})

describe('plugin install helpers', () => {
  it('rewrites legacy marketplace URLs to the canonical raw source', () => {
    const normalized = normalizeMarketplacePluginUrl('https://github.com/swarmclawai/plugins/blob/master/foo/bar.js')
    assert.equal(normalized, 'https://raw.githubusercontent.com/swarmclawai/swarmforge/main/foo/bar.js')
  })

  it('allows .js and .mjs plugin filenames and blocks traversal', () => {
    assert.equal(sanitizePluginFilename('plugin.js'), 'plugin.js')
    assert.equal(sanitizePluginFilename('plugin.mjs'), 'plugin.mjs')
    assert.throws(() => sanitizePluginFilename('../plugin.js'), /Invalid filename/)
    assert.throws(() => sanitizePluginFilename('plugin'), /Filename must end/)
  })
})

describe('plugin manager hook execution', () => {
  it('applies beforeToolExec mutations only for explicitly enabled plugins', async () => {
    const pluginId = uniquePluginId('before_tool_exec')
    getPluginManager().registerBuiltin(pluginId, {
      name: 'Before Tool Exec Test',
      hooks: {
        beforeToolExec: ({ input }) => ({ ...(input || {}), patched: true }),
      },
    })

    const withoutEnable = await getPluginManager().runBeforeToolExec(
      { toolName: 'shell', input: { original: true } },
      {},
    )
    assert.deepEqual(withoutEnable, { original: true })

    const withEnable = await getPluginManager().runBeforeToolExec(
      { toolName: 'shell', input: { original: true } },
      { enabledIds: [pluginId] },
    )
    assert.deepEqual(withEnable, { original: true, patched: true })
  })

  it('chains text transforms in plugin order', async () => {
    const pluginA = uniquePluginId('transform_a')
    const pluginB = uniquePluginId('transform_b')
    getPluginManager().registerBuiltin(pluginA, {
      name: 'Transform A',
      hooks: {
        transformOutboundMessage: ({ text }) => `${text} A`,
      },
    })
    getPluginManager().registerBuiltin(pluginB, {
      name: 'Transform B',
      hooks: {
        transformOutboundMessage: ({ text }) => `${text} B`,
      },
    })

    const transformed = await getPluginManager().transformText(
      'transformOutboundMessage',
      {
        session: {
          id: 's1',
          name: 'Test Session',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          plugins: [pluginA, pluginB],
        },
        text: 'base',
      },
      { enabledIds: [pluginA, pluginB] },
    )

    assert.equal(transformed, 'base A B')
  })

  it('does not run generic hooks unless scope is provided explicitly', async () => {
    const pluginId = uniquePluginId('scoped_hook')
    let callCount = 0
    getPluginManager().registerBuiltin(pluginId, {
      name: 'Scoped Hook Test',
      hooks: {
        afterChatTurn: () => {
          callCount += 1
        },
      },
    })

    await getPluginManager().runHook(
      'afterChatTurn',
      {
        session: {
          id: 's2',
          name: 'Scoped Hook Session',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        },
        message: 'hi',
        response: 'hello',
        source: 'chat',
        internal: false,
      },
      {},
    )
    assert.equal(callCount, 0)

    await getPluginManager().runHook(
      'afterChatTurn',
      {
        session: {
          id: 's3',
          name: 'Scoped Hook Session Enabled',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          plugins: [pluginId],
        },
        message: 'hi',
        response: 'hello',
        source: 'chat',
        internal: false,
      },
      { enabledIds: [pluginId] },
    )
    assert.equal(callCount, 1)
  })

  it('stores dependency-aware plugins in managed workspaces', async () => {
    const filename = `${uniquePluginId('workspace_plugin')}.js`
    const manager = getPluginManager()

    await manager.savePluginSource(
      filename,
      'module.exports = { name: "Workspace Plugin", tools: [] }',
      {
        packageJson: {
          name: 'workspace-plugin',
          dependencies: {
            lodash: '^4.17.21',
          },
        },
        packageManager: 'npm',
      },
    )

    const meta = manager.listPlugins().find((plugin) => plugin.filename === filename)
    assert.equal(meta?.isBuiltin, false)
    assert.equal(meta?.hasDependencyManifest, true)
    assert.equal(meta?.dependencyCount, 1)
    assert.equal(meta?.packageManager, 'npm')
    assert.equal(manager.readPluginSource(filename).includes('Workspace Plugin'), true)

    const shimPath = path.join(DATA_DIR, 'plugins', filename)
    assert.equal(fs.readFileSync(shimPath, 'utf8').includes('Auto-generated plugin workspace shim'), true)

    assert.equal(manager.deletePlugin(filename), true)
  })
})
