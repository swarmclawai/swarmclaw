import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-discovery-approval-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
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

describe('discovery tool access flows', () => {
  it('request_tool_access grants tools immediately without creating approvals', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const toolsMod = await import('./src/lib/server/session-tools/index')
      const storage = storageMod.default || storageMod
      const toolsApi = toolsMod.default || toolsMod

      const now = Date.now()
      storage.saveSessions({
        session_tools: {
          id: 'session_tools',
          name: 'Tool Access Test',
          cwd: process.env.WORKSPACE_DIR,
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'default',
          plugins: [],
        },
      })

      const built = await toolsApi.buildSessionTools(process.env.WORKSPACE_DIR, [], {
        sessionId: 'session_tools',
        agentId: 'default',
        platformAssignScope: 'self',
      })
      const tool = built.tools.find((entry) => entry.name === 'request_tool_access')
      const raw = await tool.invoke({ toolId: 'shell', reason: 'Need terminal access.' })
      const approvals = storage.loadApprovals()
      const session = storage.loadSessions().session_tools
      console.log(JSON.stringify({
        raw,
        approvalCount: Object.keys(approvals).length,
        plugins: session.plugins || [],
      }))
    `)

    assert.match(String(output.raw), /tool_access_granted|granted immediately/i)
    assert.equal(output.approvalCount, 0)
    assert.equal(output.plugins.includes('shell'), true)
  })

  it('manage_capabilities request_access grants tools immediately without approval state', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const toolsMod = await import('./src/lib/server/session-tools/index')
      const storage = storageMod.default || storageMod
      const toolsApi = toolsMod.default || toolsMod

      const now = Date.now()
      storage.saveSessions({
        session_caps: {
          id: 'session_caps',
          name: 'Capabilities Test',
          cwd: process.env.WORKSPACE_DIR,
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'default',
          plugins: [],
        },
      })

      const built = await toolsApi.buildSessionTools(process.env.WORKSPACE_DIR, [], {
        sessionId: 'session_caps',
        agentId: 'default',
        platformAssignScope: 'self',
      })
      const tool = built.tools.find((entry) => entry.name === 'manage_capabilities')
      const raw = await tool.invoke({ action: 'request_access', query: 'shell', reason: 'Need terminal access.' })
      const session = storage.loadSessions().session_caps
      console.log(JSON.stringify({
        raw,
        plugins: session.plugins || [],
      }))
    `)

    assert.match(String(output.raw), /plugin_access_granted|granted immediately/i)
    assert.equal(output.plugins.includes('shell'), true)
  })

  it('manage_capabilities request_access tells the agent to call already-available alias tools directly', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const toolsMod = await import('./src/lib/server/session-tools/index')
      const storage = storageMod.default || storageMod
      const toolsApi = toolsMod.default || toolsMod

      const now = Date.now()
      storage.saveSessions({
        session_memory: {
          id: 'session_memory',
          name: 'Memory Alias Test',
          cwd: process.env.WORKSPACE_DIR,
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'default',
          plugins: ['memory'],
        },
      })

      const built = await toolsApi.buildSessionTools(process.env.WORKSPACE_DIR, ['memory'], {
        sessionId: 'session_memory',
        agentId: 'default',
        platformAssignScope: 'self',
      })
      const tool = built.tools.find((entry) => entry.name === 'manage_capabilities')
      const raw = await tool.invoke({ action: 'request_access', query: 'memory_store', reason: 'Need to remember a user preference.' })
      console.log(JSON.stringify({ raw }))
    `)

    assert.match(String(output.raw), /"alreadyAvailable":true/)
    assert.match(String(output.raw), /memory_store\\\" directly now/i)
  })

  it('session-granted builtins disabled by default still appear in the next turn tool list', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const toolsMod = await import('./src/lib/server/session-tools/index')
      const storage = storageMod.default || storageMod
      const toolsApi = toolsMod.default || toolsMod

      const now = Date.now()
      storage.saveSessions({
        session_email: {
          id: 'session_email',
          name: 'Email Tool Test',
          cwd: process.env.WORKSPACE_DIR,
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'default',
          plugins: ['email'],
        },
      })

      const built = await toolsApi.buildSessionTools(process.env.WORKSPACE_DIR, ['email'], {
        sessionId: 'session_email',
        agentId: 'default',
        platformAssignScope: 'self',
      })
      console.log(JSON.stringify({
        toolNames: built.tools.map((entry) => entry.name).sort(),
      }))
    `)

    assert.equal(output.toolNames.includes('email'), true)
  })

  it('discover reports session-granted builtin tools as available now', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const toolsMod = await import('./src/lib/server/session-tools/index')
      const storage = storageMod.default || storageMod
      const toolsApi = toolsMod.default || toolsMod

      const now = Date.now()
      storage.saveSessions({
        session_discover_email: {
          id: 'session_discover_email',
          name: 'Discovery Email Test',
          cwd: process.env.WORKSPACE_DIR,
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'default',
          plugins: ['email'],
        },
      })

      const built = await toolsApi.buildSessionTools(process.env.WORKSPACE_DIR, ['email'], {
        sessionId: 'session_discover_email',
        agentId: 'default',
        platformAssignScope: 'self',
      })
      const tool = built.tools.find((entry) => entry.name === 'manage_capabilities')
      const raw = await tool.invoke({ action: 'discover', reason: 'Check runtime tool availability.' })
      const plugins = JSON.parse(raw)
      const email = plugins.find((entry) => entry.id === 'email')
      console.log(JSON.stringify({
        email,
      }))
    `)

    assert.equal(output.email.granted, true)
    assert.equal(output.email.availableNow, true)
  })
})
