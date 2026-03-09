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

describe('discovery approval flows', () => {
  it('request_tool_access creates a real approval and grants the tool when auto-approved', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const toolsMod = await import('./src/lib/server/session-tools/index')
      const storage = storageMod.default || storageMod
      const toolsApi = toolsMod.default || toolsMod

      storage.saveSettings({ approvalsEnabled: false })

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

    assert.match(String(output.raw), /auto-approved|granted/i)
    assert.equal(output.approvalCount, 1)
    assert.equal(output.plugins.includes('shell'), true)
  })

  it('manage_capabilities request_access accepts query aliases for pluginId', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const toolsMod = await import('./src/lib/server/session-tools/index')
      const storage = storageMod.default || storageMod
      const toolsApi = toolsMod.default || toolsMod

      storage.saveSettings({ approvalsEnabled: false })

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

    assert.match(String(output.raw), /auto-approved|granted/i)
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

  it('granting manage_schedules does not surface the manage_platform umbrella tool', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const toolsMod = await import('./src/lib/server/session-tools/index')
      const storage = storageMod.default || storageMod
      const toolsApi = toolsMod.default || toolsMod

      const now = Date.now()
      storage.saveSessions({
        session_sched: {
          id: 'session_sched',
          name: 'Schedule Tool Isolation',
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
          plugins: ['manage_schedules'],
        },
      })

      const built = await toolsApi.buildSessionTools(process.env.WORKSPACE_DIR, ['manage_schedules'], {
        sessionId: 'session_sched',
        agentId: 'default',
        platformAssignScope: 'self',
      })
      console.log(JSON.stringify({
        toolNames: built.tools.map((entry) => entry.name).sort(),
      }))
    `)

    assert.equal(output.toolNames.includes('manage_schedules'), true)
    assert.equal(output.toolNames.includes('manage_platform'), false)
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

  it('hydrates agent-approved tools into stale connector sessions on the next turn', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const toolsMod = await import('./src/lib/server/session-tools/index')
      const approvalsMod = await import('./src/lib/server/approvals')
      const storage = storageMod.default || storageMod
      const toolsApi = toolsMod.default || toolsMod
      const approvals = approvalsMod.default || approvalsMod

      const now = Date.now()
      storage.saveSettings({ approvalsEnabled: true })
      storage.saveSessions({
        connector_session: {
          id: 'connector_session',
          name: 'Connector Session',
          cwd: process.env.WORKSPACE_DIR,
          user: 'connector',
          provider: 'openai',
          model: 'gpt-test',
          claudeSessionId: null,
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'agent_1',
          plugins: ['browser'],
        },
      })

      const approval = approvals.requestApproval({
        category: 'tool_access',
        title: 'Enable connector tool',
        description: 'Grant connector messaging',
        data: { toolId: 'connector_message_tool', pluginId: 'connector_message_tool' },
        agentId: 'agent_1',
        sessionId: null,
      })
      await approvals.submitDecision(approval.id, true)

      const built = await toolsApi.buildSessionTools(process.env.WORKSPACE_DIR, ['browser'], {
        sessionId: 'connector_session',
        agentId: 'agent_1',
        platformAssignScope: 'self',
      })
      try {
        const session = storage.loadSessions().connector_session
        console.log(JSON.stringify({
          toolNames: built.tools.map((entry) => entry.name).sort(),
          plugins: session.plugins || [],
        }))
      } finally {
        await built.cleanup()
      }
    `)

    assert.equal(output.toolNames.includes('connector_message_tool'), true)
    assert.equal(output.plugins.includes('connector_message_tool'), true)
  })
})
