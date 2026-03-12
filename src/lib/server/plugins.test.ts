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
    assert.equal(canonicalizePluginId('gws'), 'google_workspace')
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

  it('matches Google Workspace aliases across canonical and CLI-facing names', () => {
    const expanded = expandPluginIds(['google_workspace'])
    assert.equal(expanded.includes('google_workspace'), true)
    assert.equal(expanded.includes('gws'), true)
    assert.equal(expanded.includes('google-workspace'), true)
    assert.equal(pluginIdMatches(['google_workspace'], 'gws'), true)
    assert.equal(pluginIdMatches(['gws'], 'google-workspace'), true)
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

  it('merges beforePromptBuild context and preserves first system prompt override', async () => {
    const pluginA = uniquePluginId('before_prompt_build_a')
    const pluginB = uniquePluginId('before_prompt_build_b')
    const session = {
      id: 'prompt-hook-session',
      name: 'Prompt Hook Session',
      cwd: process.cwd(),
      user: 'tester',
      provider: 'openai',
      model: 'gpt-test',
      claudeSessionId: null,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      plugins: [pluginA, pluginB],
    }

    getPluginManager().registerBuiltin(pluginA, {
      name: 'Before Prompt Build A',
      hooks: {
        beforePromptBuild: () => ({
          systemPrompt: 'system A',
          prependContext: 'context A',
          prependSystemContext: 'prepend A',
        }),
      },
    })
    getPluginManager().registerBuiltin(pluginB, {
      name: 'Before Prompt Build B',
      hooks: {
        beforePromptBuild: () => ({
          systemPrompt: 'system B',
          prependContext: 'context B',
          appendSystemContext: 'append B',
        }),
      },
    })

    const result = await getPluginManager().runBeforePromptBuild(
      {
        session,
        prompt: 'base prompt',
        message: 'hello',
        history: [],
        messages: [],
      },
      { enabledIds: [pluginA, pluginB] },
    )

    assert.deepEqual(result, {
      systemPrompt: 'system A',
      prependContext: 'context A\n\ncontext B',
      prependSystemContext: 'prepend A',
      appendSystemContext: 'append B',
    })
  })

  it('applies beforeToolCall params merges and block results before legacy beforeToolExec', async () => {
    const pluginA = uniquePluginId('before_tool_call_a')
    const pluginB = uniquePluginId('before_tool_call_b')
    const session = {
      id: 'tool-hook-session',
      name: 'Tool Hook Session',
      cwd: process.cwd(),
      user: 'tester',
      provider: 'openai',
      model: 'gpt-test',
      claudeSessionId: null,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      plugins: [pluginA, pluginB],
    }

    getPluginManager().registerBuiltin(pluginA, {
      name: 'Before Tool Call A',
      hooks: {
        beforeToolCall: () => ({
          params: { patched: true },
          warning: 'tool warning',
        }),
      },
    })
    getPluginManager().registerBuiltin(pluginB, {
      name: 'Before Tool Call B',
      hooks: {
        beforeToolCall: ({ input }) => ({
          block: true,
          blockReason: `blocked with patched=${String(input?.patched)}`,
        }),
        beforeToolExec: () => ({ shouldNotRun: true }),
      },
    })

    const result = await getPluginManager().runBeforeToolCall(
      {
        session,
        toolName: 'shell',
        input: { original: true },
        runId: 'run-1',
      },
      { enabledIds: [pluginA, pluginB] },
    )

    assert.deepEqual(result, {
      input: { original: true, patched: true },
      blockReason: 'blocked with patched=true',
      warning: 'tool warning',
    })
  })

  it('applies beforeModelResolve overrides in plugin order', async () => {
    const pluginA = uniquePluginId('before_model_resolve_a')
    const pluginB = uniquePluginId('before_model_resolve_b')
    const session = {
      id: 'model-resolve-session',
      name: 'Model Resolve Session',
      cwd: process.cwd(),
      user: 'tester',
      provider: 'openai',
      model: 'gpt-test',
      claudeSessionId: null,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      plugins: [pluginA, pluginB],
    }

    getPluginManager().registerBuiltin(pluginA, {
      name: 'Before Model Resolve A',
      hooks: {
        beforeModelResolve: () => ({
          providerOverride: 'ollama',
          modelOverride: 'llama-a',
        }),
      },
    })
    getPluginManager().registerBuiltin(pluginB, {
      name: 'Before Model Resolve B',
      hooks: {
        beforeModelResolve: () => ({
          modelOverride: 'llama-b',
          apiEndpointOverride: 'http://127.0.0.1:11434',
        }),
      },
    })

    const result = await getPluginManager().runBeforeModelResolve(
      {
        session,
        prompt: 'base prompt',
        message: 'hello',
        provider: session.provider,
        model: session.model,
        apiEndpoint: null,
      },
      { enabledIds: [pluginA, pluginB] },
    )

    assert.deepEqual(result, {
      providerOverride: 'ollama',
      modelOverride: 'llama-b',
      apiEndpointOverride: 'http://127.0.0.1:11434',
    })
  })

  it('chains toolResultPersist and beforeMessageWrite hooks', async () => {
    const pluginA = uniquePluginId('tool_result_persist_a')
    const pluginB = uniquePluginId('before_message_write_b')
    const session = {
      id: 'message-write-session',
      name: 'Message Write Session',
      cwd: process.cwd(),
      user: 'tester',
      provider: 'openai',
      model: 'gpt-test',
      claudeSessionId: null,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      plugins: [pluginA, pluginB],
    }

    getPluginManager().registerBuiltin(pluginA, {
      name: 'Tool Result Persist A',
      hooks: {
        toolResultPersist: ({ message, toolName }) => ({
          ...message,
          text: `${message.text} [tool:${toolName}]`,
        }),
      },
    })
    getPluginManager().registerBuiltin(pluginB, {
      name: 'Before Message Write B',
      hooks: {
        beforeMessageWrite: ({ message }) => ({
          message: {
            ...message,
            text: `${message.text} [persisted]`,
          },
        }),
      },
    })

    const persisted = await getPluginManager().runToolResultPersist(
      {
        session,
        message: {
          role: 'assistant',
          text: 'tool output',
          time: Date.now(),
        },
        toolName: 'shell',
        toolCallId: 'call-1',
      },
      { enabledIds: [pluginA, pluginB] },
    )
    const writeResult = await getPluginManager().runBeforeMessageWrite(
      {
        session,
        message: persisted,
        phase: 'assistant_final',
        runId: 'run-1',
      },
      { enabledIds: [pluginA, pluginB] },
    )

    assert.equal(writeResult.block, false)
    assert.equal(writeResult.message.text, 'tool output [tool:shell] [persisted]')
  })

  it('blocks subagent spawning when a plugin hook rejects it', async () => {
    const pluginId = uniquePluginId('subagent_spawning')

    getPluginManager().registerBuiltin(pluginId, {
      name: 'Subagent Spawning Hook',
      hooks: {
        subagentSpawning: () => ({
          status: 'error',
          error: 'blocked by lifecycle hook',
        }),
      },
    })

    const result = await getPluginManager().runSubagentSpawning(
      {
        parentSessionId: 'parent-1',
        agentId: 'agent-1',
        agentName: 'Agent One',
        message: 'do the work',
        cwd: process.cwd(),
        mode: 'run',
        threadRequested: false,
      },
      { enabledIds: [pluginId] },
    )

    assert.deepEqual(result, {
      status: 'error',
      error: 'blocked by lifecycle hook',
    })
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
