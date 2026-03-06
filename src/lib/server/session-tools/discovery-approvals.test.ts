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
      const storageMod = await import('./src/lib/server/storage.ts')
      const toolsMod = await import('./src/lib/server/session-tools/index.ts')
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
      const storageMod = await import('./src/lib/server/storage.ts')
      const toolsMod = await import('./src/lib/server/session-tools/index.ts')
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

  it('granting manage_schedules does not surface the manage_platform umbrella tool', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage.ts')
      const toolsMod = await import('./src/lib/server/session-tools/index.ts')
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
})
