import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-approval-auto-'))
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATA_DIR: tempDir,
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

describe('approval auto-approve', () => {
  it('auto-approves tool access and plugin scaffolds when configured', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage.ts')
      const approvalsMod = await import('./src/lib/server/approvals.ts')
      const dataDirMod = await import('./src/lib/server/data-dir.ts')
      const storage = storageMod.default || storageMod
      const approvals = approvalsMod.default || approvalsMod
      const dataDir = dataDirMod.DATA_DIR || dataDirMod.default?.DATA_DIR || dataDirMod['module.exports']?.DATA_DIR

      storage.saveSettings({
        approvalAutoApproveCategories: ['tool_access', 'plugin_scaffold'],
      })

      const now = Date.now()
      storage.saveSessions({
        session_auto: {
          id: 'session_auto',
          name: 'Auto Approval Test',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          credentialId: null,
          apiEndpoint: null,
          claudeSessionId: null,
          codexThreadId: null,
          opencodeSessionId: null,
          delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'default',
          plugins: [],
        },
      })

      const toolApproval = await approvals.requestApprovalMaybeAutoApprove({
        category: 'tool_access',
        title: 'Enable Plugin: shell',
        data: { toolId: 'shell', pluginId: 'shell' },
        sessionId: 'session_auto',
        agentId: 'default',
      })

      const pluginApproval = await approvals.requestApprovalMaybeAutoApprove({
        category: 'plugin_scaffold',
        title: 'Scaffold Plugin: auto-test.js',
        data: {
          filename: 'auto-test.js',
          code: 'module.exports = { name: \"AutoTestPlugin\" }',
          createdByAgentId: 'default',
        },
        sessionId: 'session_auto',
        agentId: 'default',
      })

      const sessions = storage.loadSessions()
      const pluginsDir = await import('node:path').then((path) => path.join(dataDir, 'plugins'))
      const pluginPath = await import('node:path').then((path) => path.join(pluginsDir, 'auto-test.js'))

      console.log(JSON.stringify({
        categories: approvals.listAutoApprovableApprovalCategories(),
        toolApprovalStatus: toolApproval.status,
        pluginApprovalStatus: pluginApproval.status,
        sessionPlugins: sessions.session_auto.plugins,
        pluginExists: (await import('node:fs')).existsSync(pluginPath),
      }))
    `)

    assert.equal(output.toolApprovalStatus, 'approved')
    assert.equal(output.pluginApprovalStatus, 'approved')
    assert.equal(Array.isArray(output.categories), true)
    assert.equal(output.categories.includes('wallet_transfer'), true)
    assert.equal(output.sessionPlugins.includes('shell'), true)
    assert.equal(output.pluginExists, true)
  })

  it('can disable approvals platform-wide for fully autonomous execution', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage.ts')
      const approvalsMod = await import('./src/lib/server/approvals.ts')
      const storage = storageMod.default || storageMod
      const approvals = approvalsMod.default || approvalsMod

      storage.saveSettings({
        approvalsEnabled: false,
      })

      const approval = await approvals.requestApprovalMaybeAutoApprove({
        category: 'human_loop',
        title: 'Need an answer',
        description: 'Should be auto-approved because approvals are disabled platform-wide.',
        data: { question: 'Proceed?' },
        agentId: 'default',
        sessionId: null,
      })

      const stored = storage.loadApprovals()[approval.id]
      console.log(JSON.stringify({
        approvalStatus: approval.status,
        storedStatus: stored?.status || null,
      }))
    `)

    assert.equal(output.approvalStatus, 'approved')
    assert.equal(output.storedStatus, 'approved')
  })

  it('adds a pending approval request message to the chat session when approvals are enabled', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage.ts')
      const approvalsMod = await import('./src/lib/server/approvals.ts')
      const storage = storageMod.default || storageMod
      const approvals = approvalsMod.default || approvalsMod

      const now = Date.now()
      storage.saveSettings({
        approvalsEnabled: true,
        approvalAutoApproveCategories: [],
      })
      storage.saveSessions({
        session_chat: {
          id: 'session_chat',
          name: 'Approval Chat Test',
          cwd: process.cwd(),
          user: 'tester',
          provider: 'openai',
          model: 'gpt-test',
          credentialId: null,
          apiEndpoint: null,
          claudeSessionId: null,
          codexThreadId: null,
          opencodeSessionId: null,
          delegateResumeIds: { claudeCode: null, codex: null, opencode: null, gemini: null },
          messages: [],
          createdAt: now,
          lastActiveAt: now,
          sessionType: 'human',
          agentId: 'default',
          plugins: [],
        },
      })

      const approval = await approvals.requestApprovalMaybeAutoApprove({
        category: 'tool_access',
        title: 'Enable Plugin: shell',
        description: 'Need shell access for a task.',
        data: { toolId: 'shell', pluginId: 'shell' },
        sessionId: 'session_chat',
        agentId: 'default',
      })

      const session = storage.loadSessions().session_chat
      const lastMessage = session.messages.at(-1)
      console.log(JSON.stringify({
        approvalStatus: approval.status,
        messageCount: session.messages.length,
        lastMessage,
      }))
    `)

    assert.equal(output.approvalStatus, 'pending')
    assert.equal(output.messageCount, 1)
    assert.equal(output.lastMessage.role, 'assistant')
    assert.equal(output.lastMessage.kind, 'system')
    assert.match(output.lastMessage.text, /\"type\":\"plugin_request\"/)
    assert.match(output.lastMessage.text, /\"pluginId\":\"shell\"/)
  })
})
