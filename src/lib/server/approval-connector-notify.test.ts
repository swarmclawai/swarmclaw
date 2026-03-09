import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..')

function runWithTempDataDir(script: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-approval-connector-'))
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

describe('approval connector reminders', () => {
  it('resolves a due approval to the session connector target and records one-shot delivery state', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const approvalsMod = await import('./src/lib/server/approvals')
      const storage = storageMod.default || storageMod
      const approvals = approvalsMod.default || approvalsMod

      const now = Date.now()
      storage.saveSettings({
        approvalConnectorNotifyEnabled: true,
        approvalConnectorNotifyDelaySec: 60,
      })
      storage.saveAgents({
        agent_1: {
          id: 'agent_1',
          name: 'Molly',
          description: 'Test agent',
          systemPrompt: 'You are Molly.',
          provider: 'openai',
          model: 'gpt-test',
          plugins: [],
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({
        session_1: {
          id: 'session_1',
          name: 'Connector session',
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
          messages: [
            {
              role: 'user',
              text: 'Please ask me before spending money.',
              time: now - 1_000,
              source: { connectorId: 'conn-1', channelId: 'chat-42', threadId: 'topic-7' },
            },
          ],
          createdAt: now - 120_000,
          lastActiveAt: now - 1_000,
          sessionType: 'human',
          agentId: 'agent_1',
          plugins: [],
          connectorContext: {
            connectorId: 'conn-1',
            platform: 'telegram',
            channelId: 'chat-42',
            threadId: 'topic-7',
            lastInboundAt: now - 1_000,
          },
        },
      })

      const approval = approvals.requestApproval({
        category: 'human_loop',
        title: 'Approve plugin install',
        description: 'Need permission to install a plugin.',
        data: {},
        sessionId: 'session_1',
        agentId: 'agent_1',
      })

      const dueAt = approval.createdAt + 61_000
      const reminders = approvals.listPendingApprovalsNeedingConnectorNotification({
        now: dueAt,
        runningConnectors: [
          { id: 'conn-1', agentId: 'agent_1', supportsSend: true, configuredTargets: [], recentChannelId: 'chat-42' },
        ],
      })

      approvals.markApprovalConnectorNotificationSent(approval.id, {
        at: dueAt,
        connectorId: 'conn-1',
        channelId: 'chat-42',
        threadId: 'topic-7',
        messageId: 'msg-9',
      })

      const afterSend = approvals.listPendingApprovalsNeedingConnectorNotification({
        now: dueAt + 1_000,
        runningConnectors: [
          { id: 'conn-1', agentId: 'agent_1', supportsSend: true, configuredTargets: [], recentChannelId: 'chat-42' },
        ],
      })

      const storedApproval = storage.loadApprovals()[approval.id]
      console.log(JSON.stringify({
        reminderCount: reminders.length,
        reminder: reminders[0],
        afterSendCount: afterSend.length,
        storedApproval,
      }))
    `)

    assert.equal(output.reminderCount, 1)
    assert.equal(output.reminder.connectorId, 'conn-1')
    assert.equal(output.reminder.channelId, 'chat-42')
    assert.equal(output.reminder.threadId, 'topic-7')
    assert.match(output.reminder.text, /Molly is waiting for your approval/i)
    assert.equal(output.afterSendCount, 0)
    assert.equal(output.storedApproval.connectorNotification.sentAt > 0, true)
    assert.equal(output.storedApproval.connectorNotification.messageId, 'msg-9')
  })

  it('falls back to a running owned connector and respects retry cooldowns after failed sends', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const approvalsMod = await import('./src/lib/server/approvals')
      const storage = storageMod.default || storageMod
      const approvals = approvalsMod.default || approvalsMod

      const now = Date.now()
      storage.saveSettings({
        approvalConnectorNotifyEnabled: true,
        approvalConnectorNotifyDelaySec: 30,
      })
      storage.saveAgents({
        agent_2: {
          id: 'agent_2',
          name: 'Writer',
          description: 'Test agent',
          systemPrompt: 'You are Writer.',
          provider: 'openai',
          model: 'gpt-test',
          plugins: [],
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSessions({
        session_plain: {
          id: 'session_plain',
          name: 'Non-connector session',
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
          createdAt: now - 60_000,
          lastActiveAt: now - 1_000,
          sessionType: 'human',
          agentId: 'agent_2',
          plugins: [],
        },
      })

      const approval = approvals.requestApproval({
        category: 'task_tool',
        title: 'Approve outbound outreach',
        description: 'Need your approval before sending a message.',
        data: {},
        sessionId: 'session_plain',
        agentId: 'agent_2',
      })

      const dueAt = approval.createdAt + 31_000
      const first = approvals.listPendingApprovalsNeedingConnectorNotification({
        now: dueAt,
        runningConnectors: [
          { id: 'conn-fallback', agentId: 'agent_2', supportsSend: true, configuredTargets: [], recentChannelId: 'dm-88' },
        ],
      })

      approvals.markApprovalConnectorNotificationAttempt(approval.id, {
        at: dueAt,
        connectorId: 'conn-fallback',
        channelId: 'dm-88',
        lastError: 'connector temporarily unavailable',
      })

      const withinCooldown = approvals.listPendingApprovalsNeedingConnectorNotification({
        now: dueAt + 5_000,
        runningConnectors: [
          { id: 'conn-fallback', agentId: 'agent_2', supportsSend: true, configuredTargets: [], recentChannelId: 'dm-88' },
        ],
      })

      const afterCooldown = approvals.listPendingApprovalsNeedingConnectorNotification({
        now: dueAt + (10 * 60_000) + 1_000,
        runningConnectors: [
          { id: 'conn-fallback', agentId: 'agent_2', supportsSend: true, configuredTargets: [], recentChannelId: 'dm-88' },
        ],
      })

      const storedApproval = storage.loadApprovals()[approval.id]
      console.log(JSON.stringify({
        firstCount: first.length,
        fallbackConnectorId: first[0]?.connectorId || null,
        fallbackChannelId: first[0]?.channelId || null,
        withinCooldownCount: withinCooldown.length,
        afterCooldownCount: afterCooldown.length,
        storedApproval,
      }))
    `)

    assert.equal(output.firstCount, 1)
    assert.equal(output.fallbackConnectorId, 'conn-fallback')
    assert.equal(output.fallbackChannelId, 'dm-88')
    assert.equal(output.withinCooldownCount, 0)
    assert.equal(output.afterCooldownCount, 1)
    assert.equal(output.storedApproval.connectorNotification.lastError, 'connector temporarily unavailable')
  })
})
