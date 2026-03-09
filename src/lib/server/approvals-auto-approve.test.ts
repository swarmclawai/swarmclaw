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
  it('defaults new installs to approvals auto-run', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const approvalsMod = await import('./src/lib/server/approvals')
      const storage = storageMod.default || storageMod
      const approvals = approvalsMod.default || approvalsMod

      const now = Date.now()
      storage.saveSessions({
        session_default: {
          id: 'session_default',
          name: 'Default Approval Policy Test',
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

      const settings = storage.loadSettings()
      const approval = await approvals.requestApprovalMaybeAutoApprove({
        category: 'tool_access',
        title: 'Enable Plugin: shell',
        description: 'Need shell access for a task.',
        data: { toolId: 'shell', pluginId: 'shell' },
        sessionId: 'session_default',
        agentId: 'default',
      })

      console.log(JSON.stringify({
        approvalsEnabled: settings.approvalsEnabled,
        approvalStatus: approval.status,
      }))
    `)

    assert.equal(output.approvalsEnabled, false)
    assert.equal(output.approvalStatus, 'approved')
  })

  it('auto-approves tool access and plugin scaffolds when configured', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const approvalsMod = await import('./src/lib/server/approvals')
      const dataDirMod = await import('./src/lib/server/data-dir')
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
      const storageMod = await import('./src/lib/server/storage')
      const approvalsMod = await import('./src/lib/server/approvals')
      const sessionRunsMod = await import('./src/lib/server/session-run-manager')
      const storage = storageMod.default || storageMod
      const approvals = approvalsMod.default || approvalsMod
      const sessionRuns = sessionRunsMod.default || sessionRunsMod

      const now = Date.now()
      storage.saveSessions({
        session_disabled: {
          id: 'session_disabled',
          name: 'Disabled Approval Session',
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

      storage.saveSettings({
        approvalsEnabled: false,
      })

      const approval = await approvals.requestApprovalMaybeAutoApprove({
        category: 'human_loop',
        title: 'Need an answer',
        description: 'Should be auto-approved because approvals are disabled platform-wide.',
        data: { question: 'Proceed?' },
        agentId: 'default',
        sessionId: 'session_disabled',
      })

      await new Promise((resolve) => setTimeout(resolve, 500))

      const stored = storage.loadApprovals()[approval.id]
      console.log(JSON.stringify({
        approvalStatus: approval.status,
        storedStatus: stored?.status || null,
        runCount: sessionRuns.listRuns({ sessionId: 'session_disabled', limit: 10 }).length,
      }))
    `)

    assert.equal(output.approvalStatus, 'approved')
    assert.equal(output.storedStatus, 'approved')
    assert.equal(output.runCount, 0)
  })

  it('adds a pending approval request message to the chat session when approvals are enabled', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const approvalsMod = await import('./src/lib/server/approvals')
      const storage = storageMod.default || storageMod
      const approvals = approvalsMod.default || approvalsMod

      const now = Date.now()
      storage.saveSettings({
        approvalsEnabled: true,
        approvalAutoApproveCategories: [],
        approvalConnectorNotifyDelaySec: 30,
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

  it('injects approval guidance only from enabled plugins', () => {
    const output = runWithTempDataDir(`
      process.on('unhandledRejection', () => {})
      await import('./src/lib/server/session-tools/wallet')
      const storageMod = await import('./src/lib/server/storage')
      const approvalsMod = await import('./src/lib/server/approvals')
      const storage = storageMod.default || storageMod
      const approvals = approvalsMod.default || approvalsMod

      const now = Date.now()
      storage.saveAgents({
        agent_wallet: {
          id: 'agent_wallet',
          name: 'Wallet Agent',
          description: 'Tests plugin approval guidance',
          systemPrompt: 'test',
          provider: 'openai',
          model: 'gpt-test',
          plugins: ['wallet'],
          createdAt: now,
          updatedAt: now,
        },
        agent_plain: {
          id: 'agent_plain',
          name: 'Plain Agent',
          description: 'No wallet plugin',
          systemPrompt: 'test',
          provider: 'openai',
          model: 'gpt-test',
          plugins: [],
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSettings({
        approvalsEnabled: true,
        approvalAutoApproveCategories: [],
      })
      storage.saveSessions({
        session_wallet_guidance: {
          id: 'session_wallet_guidance',
          name: 'Wallet Guidance Session',
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
          agentId: 'agent_wallet',
          plugins: ['wallet'],
          connectorContext: {
            connectorId: 'connector_wallet',
            channelId: 'chan_wallet',
          },
        },
        session_plain_guidance: {
          id: 'session_plain_guidance',
          name: 'Plain Guidance Session',
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
          agentId: 'agent_plain',
          plugins: [],
        },
      })

      const walletApproval = await approvals.requestApprovalMaybeAutoApprove({
        category: 'wallet_action',
        title: 'Wallet action: send transaction',
        description: 'Broadcast an Ethereum transaction on Arbitrum.',
        data: {
          action: 'send_transaction',
          chain: 'ethereum',
          network: 'arbitrum',
          summary: 'swap 1 USDC',
          transaction: {
            to: '0x000000000000000000000000000000000000dEaD',
            data: '0x1234',
            value: '0',
          },
        },
        sessionId: 'session_wallet_guidance',
        agentId: 'agent_wallet',
      })

      const plainApproval = await approvals.requestApprovalMaybeAutoApprove({
        category: 'wallet_action',
        title: 'Wallet action: send transaction',
        description: 'Broadcast an Ethereum transaction on Arbitrum.',
        data: {
          action: 'send_transaction',
          chain: 'ethereum',
          network: 'arbitrum',
          summary: 'swap 1 USDC',
          transaction: {
            to: '0x000000000000000000000000000000000000dEaD',
            data: '0x1234',
            value: '0',
          },
        },
        sessionId: 'session_plain_guidance',
        agentId: 'agent_plain',
      })

      const walletMessage = JSON.parse(storage.loadSessions().session_wallet_guidance.messages.at(-1).text)
      const plainMessage = JSON.parse(storage.loadSessions().session_plain_guidance.messages.at(-1).text)
      console.log(JSON.stringify({
        walletGuidance: walletMessage.guidance || [],
        plainGuidance: plainMessage.guidance || [],
      }))
    `)

    assert.equal(Array.isArray(output.walletGuidance), true)
    assert.equal(output.walletGuidance.some((line: string) => /wallet_tool/.test(line)), true)
    assert.deepEqual(output.plainGuidance, [])
  })

  it('derives tool-access approval guidance from the requested plugin metadata', () => {
    const output = runWithTempDataDir(`
      process.on('unhandledRejection', () => {})
      await import('./src/lib/server/session-tools/http')
      const storageMod = await import('./src/lib/server/storage')
      const approvalsMod = await import('./src/lib/server/approvals')
      const storage = storageMod.default || storageMod
      const approvals = approvalsMod.default || approvalsMod

      const now = Date.now()
      storage.saveSettings({
        approvalsEnabled: true,
        approvalAutoApproveCategories: [],
      })
      storage.saveSessions({
        session_http_guidance: {
          id: 'session_http_guidance',
          name: 'HTTP Guidance Session',
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
          agentId: 'agent_http',
          plugins: [],
        },
      })

      await approvals.requestApprovalMaybeAutoApprove({
        category: 'tool_access',
        title: 'Enable Plugin: http',
        description: 'Need HTTP access for an API task.',
        data: { toolId: 'http', pluginId: 'http' },
        sessionId: 'session_http_guidance',
        agentId: 'agent_http',
      })

      const message = JSON.parse(storage.loadSessions().session_http_guidance.messages.at(-1).text)
      console.log(JSON.stringify({ guidance: message.guidance || [] }))
    `)

    assert.equal(Array.isArray(output.guidance), true)
    assert.equal(output.guidance.some((line: string) => /http_request/.test(line)), true)
  })

  it('injects plugin-owned scaffold guidance for plugin creator approvals', () => {
    const output = runWithTempDataDir(`
      process.on('unhandledRejection', () => {})
      await import('./src/lib/server/session-tools/plugin-creator')
      const storageMod = await import('./src/lib/server/storage')
      const approvalsMod = await import('./src/lib/server/approvals')
      const storage = storageMod.default || storageMod
      const approvals = approvalsMod.default || approvalsMod

      const now = Date.now()
      storage.saveAgents({
        agent_plugins: {
          id: 'agent_plugins',
          name: 'Plugin Agent',
          description: 'Tests plugin creator approval guidance',
          systemPrompt: 'test',
          provider: 'openai',
          model: 'gpt-test',
          plugins: ['plugin_creator'],
          createdAt: now,
          updatedAt: now,
        },
      })
      storage.saveSettings({
        approvalsEnabled: true,
        approvalAutoApproveCategories: [],
      })
      storage.saveSessions({
        session_plugin_creator_guidance: {
          id: 'session_plugin_creator_guidance',
          name: 'Plugin Creator Guidance Session',
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
          agentId: 'agent_plugins',
          plugins: ['plugin_creator'],
        },
      })

      await approvals.requestApprovalMaybeAutoApprove({
        category: 'plugin_scaffold',
        title: 'Scaffold Plugin: test-plugin.js',
        description: 'Create a test plugin file.',
        data: {
          filename: 'test-plugin.js',
          code: 'module.exports = { name: "Test Plugin" }',
          packageManager: 'npm',
        },
        sessionId: 'session_plugin_creator_guidance',
        agentId: 'agent_plugins',
      })

      const message = JSON.parse(storage.loadSessions().session_plugin_creator_guidance.messages.at(-1).text)
      console.log(JSON.stringify({ guidance: message.guidance || [] }))
    `)

    assert.equal(Array.isArray(output.guidance), true)
    assert.equal(output.guidance.some((line: string) => /plugin_creator_tool/.test(line)), true)
  })

  it('applies tool access after a manual approval decision', () => {
    const output = runWithTempDataDir(`
      process.on('unhandledRejection', () => {})
      const storageMod = await import('./src/lib/server/storage')
      const approvalsMod = await import('./src/lib/server/approvals')
      const storage = storageMod.default || storageMod
      const approvals = approvalsMod.default || approvalsMod

      const now = Date.now()
      storage.saveSettings({
        approvalsEnabled: true,
        approvalAutoApproveCategories: [],
      })
      storage.saveSessions({
        session_manual: {
          id: 'session_manual',
          name: 'Manual Approval Test',
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
        sessionId: 'session_manual',
        agentId: 'default',
      })
      await approvals.submitDecision(approval.id, true)

      const storedApproval = storage.loadApprovals()[approval.id]
      const session = storage.loadSessions().session_manual
      console.log(JSON.stringify({
        initialStatus: approval.status,
        finalStatus: storedApproval?.status || null,
        plugins: session.plugins || [],
      }))
    `)

    assert.equal(output.initialStatus, 'pending')
    assert.equal(output.finalStatus, 'approved')
    assert.equal(output.plugins.includes('shell'), true)
  })

  it('wakes the blocked session after a manual approval decision', () => {
    const output = runWithTempDataDir(`
      process.on('unhandledRejection', () => {})
      const storageMod = await import('./src/lib/server/storage')
      const approvalsMod = await import('./src/lib/server/approvals')
      const sessionRunsMod = await import('./src/lib/server/session-run-manager')
      const storage = storageMod.default || storageMod
      const approvals = approvalsMod.default || approvalsMod
      const sessionRuns = sessionRunsMod.default || sessionRunsMod

      const now = Date.now()
      storage.saveSettings({
        approvalsEnabled: true,
        approvalAutoApproveCategories: [],
      })
      storage.saveSessions({
        session_resume: {
          id: 'session_resume',
          name: 'Resume Approval Test',
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
        category: 'wallet_action',
        title: 'Wallet action: sign transaction',
        description: 'Sign an Ethereum transaction on Arbitrum.',
        data: {
          action: 'sign_transaction',
          chain: 'ethereum',
          network: 'arbitrum',
        },
        sessionId: 'session_resume',
        agentId: 'default',
      })

      await approvals.submitDecision(approval.id, true)
      await approvals.submitDecision(approval.id, true)
      await new Promise((resolve) => setTimeout(resolve, 600))

      const runs = sessionRuns.listRuns({ sessionId: 'session_resume', limit: 10 })
      console.log(JSON.stringify({
        finalStatus: storage.loadApprovals()[approval.id]?.status || null,
        runCount: runs.length,
        runSources: runs.map((run) => run.source),
        runStatuses: runs.map((run) => run.status),
      }))
    `)

    assert.equal(output.finalStatus, 'approved')
    assert.equal(output.runCount >= 1, true)
    assert.equal(output.runSources.filter((source: any) => source === "approval-decision").length, 1)
  })

  it('reuses equivalent wallet approvals instead of creating duplicates', () => {
    const output = runWithTempDataDir(`
      process.on('unhandledRejection', () => {})
      const storageMod = await import('./src/lib/server/storage')
      const approvalsMod = await import('./src/lib/server/approvals')
      const storage = storageMod.default || storageMod
      const approvals = approvalsMod.default || approvalsMod

      const now = Date.now()
      storage.saveSettings({
        approvalsEnabled: true,
        approvalAutoApproveCategories: [],
      })
      storage.saveSessions({
        session_wallet: {
          id: 'session_wallet',
          name: 'Wallet Approval Dedupe Test',
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

      const requestParams = {
        category: 'wallet_action',
        title: 'Wallet action: sign transaction',
        description: 'Sign an Ethereum transaction on Arbitrum.',
        data: {
          action: 'sign_transaction',
          chain: 'ethereum',
          network: 'arbitrum',
          transaction: {
            to: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
            data: '0x095ea7b3000000000000000000000000216b4b4ba9f3e719726886d34a177484278bfcae00000000000000000000000000000000000000000000000000000000000f4240',
            value: '0',
          },
        },
        sessionId: 'session_wallet',
        agentId: 'default',
      }

      const first = await approvals.requestApprovalMaybeAutoApprove(requestParams)
      const second = await approvals.requestApprovalMaybeAutoApprove(requestParams)
      await approvals.submitDecision(first.id, true)
      const third = await approvals.requestApprovalMaybeAutoApprove(requestParams)

      const allApprovals = storage.loadApprovals()
      console.log(JSON.stringify({
        firstId: first.id,
        secondId: second.id,
        thirdId: third.id,
        secondStatus: second.status,
        thirdStatus: third.status,
        approvalCount: Object.keys(allApprovals).length,
      }))
    `)

    assert.equal(output.firstId, output.secondId)
    assert.equal(output.firstId, output.thirdId)
    assert.equal(output.secondStatus, 'pending')
    assert.equal(output.thirdStatus, 'approved')
    assert.equal(output.approvalCount, 1)
  })

  it('reuses approved tool-access decisions across sessions for the same agent', () => {
    const output = runWithTempDataDir(`
      const storageMod = await import('./src/lib/server/storage')
      const approvalsMod = await import('./src/lib/server/approvals')
      const storage = storageMod.default || storageMod
      const approvals = approvalsMod.default || approvalsMod

      const now = Date.now()
      storage.saveSettings({
        approvalsEnabled: true,
        approvalAutoApproveCategories: [],
      })

      const first = await approvals.requestApprovalMaybeAutoApprove({
        category: 'tool_access',
        title: 'Enable connector tool',
        description: 'Grant connector messaging',
        data: { toolId: 'connector_message_tool', pluginId: 'connector_message_tool' },
        agentId: 'agent_1',
      })
      await approvals.submitDecision(first.id, true)

      const approvalsStore = storage.loadApprovals()
      approvalsStore[first.id].updatedAt = now - (24 * 60 * 60 * 1000)
      storage.upsertApproval(first.id, approvalsStore[first.id])

      const second = await approvals.requestApprovalMaybeAutoApprove({
        category: 'tool_access',
        title: 'Enable connector tool',
        description: 'Grant connector messaging again',
        data: { toolId: 'connector_message_tool', pluginId: 'connector_message_tool' },
        agentId: 'agent_1',
      })

      console.log(JSON.stringify({
        firstId: first.id,
        secondId: second.id,
        secondStatus: second.status,
        approvalCount: Object.keys(storage.loadApprovals()).length,
      }))
    `)

    assert.equal(output.firstId, output.secondId)
    assert.equal(output.secondStatus, 'approved')
    assert.equal(output.approvalCount, 1)
  })
})
