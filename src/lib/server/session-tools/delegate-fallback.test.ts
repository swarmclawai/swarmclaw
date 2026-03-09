import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

function writeExecutable(dir: string, name: string, source: string) {
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, source, { mode: 0o755 })
  return filePath
}

function runWithFakeDelegates(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-delegate-fallback-'))
  try {
    writeExecutable(tempDir, 'claude', `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"loggedIn":false}'
  exit 1
fi
echo "unexpected claude invocation" >&2
exit 2
`)

    writeExecutable(tempDir, 'codex', `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  echo 'logged in'
  exit 0
fi
if [ "$1" = "exec" ]; then
  cat >/dev/null
  printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"codex fallback ok"}}'
  exit 0
fi
echo "unexpected codex invocation" >&2
exit 2
`)

    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH || ''}`,
      },
      encoding: 'utf-8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout || 'subprocess failed')
    const lines = (result.stdout || '')
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const jsonLine = [...lines].reverse().find((line) => line.startsWith('{') || line.startsWith('['))
    return JSON.parse(jsonLine || '{}')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('delegate fallback', () => {
  it('falls back to another backend when Claude Code is unavailable', () => {
    const output = runWithFakeDelegates(`
      const mod = await import('./src/lib/server/session-tools/delegate')
      const { buildDelegateTools } = mod.default || mod['module.exports'] || mod

      const tools = buildDelegateTools({
        cwd: process.cwd(),
        ctx: { sessionId: 'session-test', agentId: 'agent-test', platformAssignScope: 'self' },
        hasPlugin: (name) => name === 'delegate',
        hasTool: (name) => name === 'delegate',
        cleanupFns: [],
        commandTimeoutMs: 5000,
        claudeTimeoutMs: 5000,
        cliProcessTimeoutMs: 5000,
        persistDelegateResumeId: () => {},
        readStoredDelegateResumeId: () => null,
        resolveCurrentSession: () => null,
        activePlugins: ['delegate'],
      })

      const delegateTool = tools.find((tool) => tool.name === 'delegate')
      const raw = await delegateTool.invoke({ task: 'write a helper', backend: 'claude' })
      console.log(raw)
    `)

    assert.equal(output.backend, 'codex')
    assert.equal(output.status, 'completed')
    assert.match(String(output.response || ''), /codex fallback ok/i)
  })

  it('accepts wrapped function-call payloads with tool_name aliases', () => {
    const output = runWithFakeDelegates(`
      const mod = await import('./src/lib/server/session-tools/delegate')
      const { buildDelegateTools } = mod.default || mod['module.exports'] || mod

      const tools = buildDelegateTools({
        cwd: process.cwd(),
        ctx: { sessionId: 'session-test', agentId: 'agent-test', platformAssignScope: 'self' },
        hasPlugin: (name) => name === 'delegate',
        hasTool: (name) => name === 'delegate',
        cleanupFns: [],
        commandTimeoutMs: 5000,
        claudeTimeoutMs: 5000,
        cliProcessTimeoutMs: 5000,
        persistDelegateResumeId: () => {},
        readStoredDelegateResumeId: () => null,
        resolveCurrentSession: () => null,
        activePlugins: ['delegate'],
      })

      const delegateTool = tools.find((tool) => tool.name === 'delegate')
      const raw = await delegateTool.invoke({
        input: JSON.stringify({
          function: 'delegate',
          parameters: {
            tool_name: 'Claude Code',
            parameters: {
              task: 'Create a proof file',
            },
          },
        }),
      })
      console.log(raw)
    `)

    assert.equal(output.backend, 'codex')
    assert.equal(output.status, 'completed')
    assert.match(String(output.response || ''), /codex fallback ok/i)
  })

  it('rejects delegating a locally available tool call', () => {
    const output = runWithFakeDelegates(`
      const mod = await import('./src/lib/server/session-tools/delegate')
      const { buildDelegateTools } = mod.default || mod['module.exports'] || mod

      const tools = buildDelegateTools({
        cwd: process.cwd(),
        ctx: { sessionId: 'session-test', agentId: 'agent-test', platformAssignScope: 'self' },
        hasPlugin: (name) => name === 'delegate' || name === 'memory' || name === 'memory_store',
        hasTool: (name) => name === 'delegate' || name === 'memory' || name === 'memory_store',
        cleanupFns: [],
        commandTimeoutMs: 5000,
        claudeTimeoutMs: 5000,
        cliProcessTimeoutMs: 5000,
        persistDelegateResumeId: () => {},
        readStoredDelegateResumeId: () => null,
        resolveCurrentSession: () => null,
        activePlugins: ['delegate', 'memory'],
      })

      const delegateTool = tools.find((tool) => tool.name === 'delegate')
      const raw = await delegateTool.invoke({
        input: JSON.stringify({
          tool: 'memory_store',
          args: {
            title: 'User programming preferences',
            value: 'Favorite language: Rust',
          },
        }),
      })
      console.log(JSON.stringify({ raw }))
    `)

    assert.match(String(output.raw || ''), /Call `memory` directly|Call `memory_store` directly|already available in this session/i)
  })

  it('synthesizes a delegated task from write-style payloads', () => {
    const output = runWithFakeDelegates(`
      const mod = await import('./src/lib/server/session-tools/delegate')
      const { buildDelegateTools } = mod.default || mod['module.exports'] || mod

      const tools = buildDelegateTools({
        cwd: process.cwd(),
        ctx: { sessionId: 'session-test', agentId: 'agent-test', platformAssignScope: 'self' },
        hasPlugin: (name) => name === 'delegate',
        hasTool: (name) => name === 'delegate',
        cleanupFns: [],
        commandTimeoutMs: 5000,
        claudeTimeoutMs: 5000,
        cliProcessTimeoutMs: 5000,
        persistDelegateResumeId: () => {},
        readStoredDelegateResumeId: () => null,
        resolveCurrentSession: () => null,
        activePlugins: ['delegate'],
      })

      const delegateTool = tools.find((tool) => tool.name === 'delegate')
      const raw = await delegateTool.invoke({
        input: JSON.stringify({
          action: 'write',
          target: 'delegate-proof.md',
          content: 'Proof content',
        }),
      })
      console.log(raw)
    `)

    assert.equal(output.backend, 'codex')
    assert.equal(output.status, 'completed')
    assert.match(String(output.response || ''), /codex fallback ok/i)
  })

  it('synthesizes a delegated task for action=start payloads that only provide files', () => {
    const output = runWithFakeDelegates(`
      const mod = await import('./src/lib/server/session-tools/delegate')
      const { buildDelegateTools } = mod.default || mod['module.exports'] || mod

      const tools = buildDelegateTools({
        cwd: process.cwd(),
        ctx: { sessionId: 'session-test', agentId: 'agent-test', platformAssignScope: 'self' },
        hasPlugin: (name) => name === 'delegate',
        hasTool: (name) => name === 'delegate',
        cleanupFns: [],
        commandTimeoutMs: 5000,
        claudeTimeoutMs: 5000,
        cliProcessTimeoutMs: 5000,
        persistDelegateResumeId: () => {},
        readStoredDelegateResumeId: () => null,
        resolveCurrentSession: () => null,
        activePlugins: ['delegate'],
      })

      const delegateTool = tools.find((tool) => tool.name === 'delegate')
      const raw = await delegateTool.invoke({
        input: JSON.stringify({
          action: 'start',
          name: 'Create Weather Script',
          files: [{
            path: 'weather_update/weather_fetcher.py',
            content: 'print("weather")',
          }],
        }),
      })
      console.log(raw)
    `)

    assert.equal(output.backend, 'codex')
    assert.equal(output.status, 'completed')
    assert.match(String(output.response || ''), /codex fallback ok/i)
  })

  it('uses nested data.task payloads from recent tool-call wrappers', () => {
    const output = runWithFakeDelegates(`
      const mod = await import('./src/lib/server/session-tools/delegate')
      const { buildDelegateTools } = mod.default || mod['module.exports'] || mod

      const tools = buildDelegateTools({
        cwd: process.cwd(),
        ctx: { sessionId: 'session-test', agentId: 'agent-test', platformAssignScope: 'self' },
        hasPlugin: (name) => name === 'delegate',
        hasTool: (name) => name === 'delegate',
        cleanupFns: [],
        commandTimeoutMs: 5000,
        claudeTimeoutMs: 5000,
        cliProcessTimeoutMs: 5000,
        persistDelegateResumeId: () => {},
        readStoredDelegateResumeId: () => null,
        resolveCurrentSession: () => null,
        activePlugins: ['delegate'],
      })

      const delegateTool = tools.find((tool) => tool.name === 'delegate')
      const raw = await delegateTool.invoke({
        input: JSON.stringify({
          data: {
            task: 'Create a simple to-do list application.',
          },
        }),
      })
      console.log(raw)
    `)

    assert.equal(output.backend, 'codex')
    assert.equal(output.status, 'completed')
    assert.match(String(output.response || ''), /codex fallback ok/i)
  })

  it('falls back to reason text when malformed delegate wrappers omit task', () => {
    const output = runWithFakeDelegates(`
      const mod = await import('./src/lib/server/session-tools/delegate')
      const { buildDelegateTools } = mod.default || mod['module.exports'] || mod

      const tools = buildDelegateTools({
        cwd: process.cwd(),
        ctx: { sessionId: 'session-test', agentId: 'agent-test', platformAssignScope: 'self' },
        hasPlugin: (name) => name === 'delegate',
        hasTool: (name) => name === 'delegate',
        cleanupFns: [],
        commandTimeoutMs: 5000,
        claudeTimeoutMs: 5000,
        cliProcessTimeoutMs: 5000,
        persistDelegateResumeId: () => {},
        readStoredDelegateResumeId: () => null,
        resolveCurrentSession: () => null,
        activePlugins: ['delegate'],
      })

      const delegateTool = tools.find((tool) => tool.name === 'delegate')
      const raw = await delegateTool.invoke({
        input: JSON.stringify({
          parameters: {
            tool_id: 'delegate',
            reason: 'Building a simple front-end to-do list app is well-suited for a delegated agent.',
            subagent_tool_id: 'agent_coder',
            subagent_name: 'Coder',
          },
        }),
      })
      console.log(raw)
    `)

    assert.equal(output.backend, 'codex')
    assert.equal(output.status, 'completed')
    assert.match(String(output.response || ''), /codex fallback ok/i)
  })

  it('accepts legacy id fields for lifecycle delegate actions', () => {
    const output = runWithFakeDelegates(`
      const mod = await import('./src/lib/server/session-tools/delegate')
      const { buildDelegateTools } = mod.default || mod['module.exports'] || mod

      const tools = buildDelegateTools({
        cwd: process.cwd(),
        ctx: { sessionId: 'session-test', agentId: 'agent-test', platformAssignScope: 'self' },
        hasPlugin: (name) => name === 'delegate',
        hasTool: (name) => name === 'delegate',
        cleanupFns: [],
        commandTimeoutMs: 5000,
        claudeTimeoutMs: 5000,
        cliProcessTimeoutMs: 5000,
        persistDelegateResumeId: () => {},
        readStoredDelegateResumeId: () => null,
        resolveCurrentSession: () => null,
        activePlugins: ['delegate'],
      })

      const delegateTool = tools.find((tool) => tool.name === 'delegate')
      const raw = await delegateTool.invoke({ action: 'status', id: 'job-123' })
      console.log(JSON.stringify({ raw }))
    `)

    assert.match(String(output.raw || ''), /delegation job "job-123" not found/i)
  })

  it('ranks authenticated delegate backends ahead of unauthenticated ones', () => {
    const output = runWithFakeDelegates(`
      const mod = await import('./src/lib/server/provider-health')
      const { rankDelegatesByHealth } = mod.default || mod['module.exports'] || mod
      const ranked = rankDelegatesByHealth(['delegate_to_claude_code', 'delegate_to_codex_cli'])
      console.log(JSON.stringify(ranked))
    `)

    assert.deepEqual(output, ['delegate_to_codex_cli', 'delegate_to_claude_code'])
  })
})
