import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import type { Agent, Session } from '@/types'

const originalEnv = {
  DATA_DIR: process.env.DATA_DIR,
  WORKSPACE_DIR: process.env.WORKSPACE_DIR,
  SWARMCLAW_BUILD_MODE: process.env.SWARMCLAW_BUILD_MODE,
  CREDENTIAL_SECRET: process.env.CREDENTIAL_SECRET,
}

let tempDir = ''
let workspaceDir = ''
let buildWalletTools: typeof import('./wallet').buildWalletTools
let createAgentWallet: typeof import('../wallet-service').createAgentWallet
let storage: typeof import('../storage')

function makeAgent(): Agent {
  const now = Date.now()
  return {
    id: 'agent_wallet',
    name: 'Wallet Agent',
    description: 'Tests wallet actions',
    systemPrompt: 'test',
    provider: 'ollama',
    model: 'qwen3.5',
    plugins: ['wallet'],
    createdAt: now,
    updatedAt: now,
  }
}

function makeSession(): Session {
  const now = Date.now()
  return {
    id: 'session_wallet',
    name: 'Wallet Session',
    cwd: workspaceDir,
    user: 'tester',
    provider: 'ollama',
    model: 'qwen3.5',
    claudeSessionId: null,
    messages: [],
    createdAt: now,
    lastActiveAt: now,
    plugins: ['wallet'],
    agentId: 'agent_wallet',
  }
}

function makeBuildContext(session: Session) {
  return {
    cwd: workspaceDir,
    ctx: {
      sessionId: session.id,
      agentId: session.agentId || null,
    },
    hasPlugin: (pluginId: string) => pluginId === 'wallet',
    hasTool: () => true,
    cleanupFns: [],
    commandTimeoutMs: 5000,
    claudeTimeoutMs: 5000,
    cliProcessTimeoutMs: 5000,
    persistDelegateResumeId: () => {},
    readStoredDelegateResumeId: () => null,
    resolveCurrentSession: () => session,
    activePlugins: ['wallet'],
  }
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-wallet-tool-'))
  workspaceDir = path.join(tempDir, 'workspace')
  process.env.DATA_DIR = path.join(tempDir, 'data')
  process.env.WORKSPACE_DIR = workspaceDir
  process.env.SWARMCLAW_BUILD_MODE = '1'
  process.env.CREDENTIAL_SECRET = '22'.repeat(32)
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true })
  fs.mkdirSync(workspaceDir, { recursive: true })

  ;({ buildWalletTools } = await import('./wallet'))
  ;({ createAgentWallet } = await import('../wallet-service'))
  storage = await import('../storage')

  storage.saveSettings({
    approvalsEnabled: true,
    approvalAutoApproveCategories: [],
  })
  storage.saveAgents({ agent_wallet: makeAgent() })
  storage.saveSessions({ session_wallet: makeSession() })
})

after(() => {
  if (originalEnv.DATA_DIR === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalEnv.DATA_DIR
  if (originalEnv.WORKSPACE_DIR === undefined) delete process.env.WORKSPACE_DIR
  else process.env.WORKSPACE_DIR = originalEnv.WORKSPACE_DIR
  if (originalEnv.SWARMCLAW_BUILD_MODE === undefined) delete process.env.SWARMCLAW_BUILD_MODE
  else process.env.SWARMCLAW_BUILD_MODE = originalEnv.SWARMCLAW_BUILD_MODE
  if (originalEnv.CREDENTIAL_SECRET === undefined) delete process.env.CREDENTIAL_SECRET
  else process.env.CREDENTIAL_SECRET = originalEnv.CREDENTIAL_SECRET
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('wallet tool generic execution', () => {
  it('requests approval before signing a message', async () => {
    createAgentWallet({ agentId: 'agent_wallet', chain: 'ethereum' })
    const session = makeSession()
    const [walletTool] = buildWalletTools(makeBuildContext(session))

    const result = JSON.parse(String(await walletTool.invoke({
      action: 'sign_message',
      chain: 'ethereum',
      message: 'approve me',
    })))

    assert.equal(result.type, 'plugin_wallet_action_request')
    assert.equal(result.action, 'sign_message')

    const approvals = storage.loadApprovals()
    const pending: any = Object.values(approvals).find((approval: any) => approval.category === 'wallet_action')
    assert.ok(pending)
    assert.equal(pending?.status, 'pending')
  })

  it('signs messages after approval and encodes contract calls', async () => {
    const session = makeSession()
    const [walletTool] = buildWalletTools(makeBuildContext(session))

    const bypassAttempt = JSON.parse(String(await walletTool.invoke({
      action: 'sign_message',
      chain: 'ethereum',
      message: 'signed',
      approved: true,
    })))
    assert.match(String(bypassAttempt.error || ''), /approvalId/i)

    const approvalRequest = JSON.parse(String(await walletTool.invoke({
      action: 'sign_message',
      chain: 'ethereum',
      message: 'signed',
    })))
    assert.equal(approvalRequest.type, 'plugin_wallet_action_request')

    const approvals = storage.loadApprovals()
    const pending: any = approvalRequest.approvalId ? approvals[approvalRequest.approvalId] : undefined
    assert.ok(pending)
    storage.upsertApproval(pending!.id, {
      ...pending,
      status: 'approved',
      updatedAt: Date.now(),
    })

    const signResult = JSON.parse(String(await walletTool.invoke({
      action: 'sign_message',
      chain: 'ethereum',
      message: 'signed',
      approvalId: pending!.id,
    })))
    assert.equal(signResult.status, 'signed')
    assert.equal(signResult.chain, 'ethereum')
    assert.equal(typeof signResult.signature, 'string')

    const encoded = JSON.parse(String(await walletTool.invoke({
      action: 'encode_contract_call',
      chain: 'ethereum',
      abi: JSON.stringify(['function approve(address spender,uint256 amount)']),
      functionName: 'approve',
      args: JSON.stringify(['0x000000000000000000000000000000000000dEaD', '5']),
    })))
    assert.equal(encoded.status, 'encoded')
    assert.equal(encoded.data.startsWith('0x095ea7b3'), true)
  })

  it('requests a fresh approval when a stale approvalId is reused for a changed transaction', async () => {
    const session = makeSession()
    const [walletTool] = buildWalletTools(makeBuildContext(session))

    const firstApproval = JSON.parse(String(await walletTool.invoke({
      action: 'send_transaction',
      chain: 'ethereum',
      network: 'arbitrum',
      toAddress: '0x000000000000000000000000000000000000dEaD',
      data: '0x1234',
    })))
    assert.equal(firstApproval.type, 'plugin_wallet_action_request')
    assert.equal(typeof firstApproval.approvalId, 'string')

    const approvals = storage.loadApprovals()
    const approved = approvals[firstApproval.approvalId]
    assert.ok(approved)
    storage.upsertApproval(firstApproval.approvalId, {
      ...approved,
      status: 'approved',
      updatedAt: Date.now(),
    })

    const replacement = JSON.parse(String(await walletTool.invoke({
      action: 'send_transaction',
      chain: 'ethereum',
      network: 'arbitrum',
      toAddress: '0x000000000000000000000000000000000000bEEF',
      data: '0x5678',
      approvalId: firstApproval.approvalId,
    })))

    assert.equal(replacement.type, 'plugin_wallet_action_request')
    assert.equal(typeof replacement.approvalId, 'string')
    assert.notEqual(replacement.approvalId, firstApproval.approvalId)
    assert.equal(replacement.replacesApprovalId, firstApproval.approvalId)

    const nextApprovals = storage.loadApprovals()
    assert.equal(nextApprovals[replacement.approvalId]?.status, 'pending')
  })

  it('requests one resumable approval for a live swap intent when approvals are enabled', async () => {
    const wallets = storage.loadWallets() as Record<string, { id: string; agentId: string; chain: string; publicKey: string }>
    const existingEthWallet = Object.values(wallets).find((wallet) => wallet.agentId === 'agent_wallet' && wallet.chain === 'ethereum')
    const ethWallet = existingEthWallet || createAgentWallet({ agentId: 'agent_wallet', chain: 'ethereum' })
    storage.upsertWallet(ethWallet.id, {
      ...(wallets[ethWallet.id] || ethWallet),
      publicKey: '0x684faBf3F7a39aD667b503E771b86b99a09C8b30',
      updatedAt: Date.now(),
    })

    const session = makeSession()
    const [walletTool] = buildWalletTools(makeBuildContext(session))

    const approvalRequest = JSON.parse(String(await walletTool.invoke({
      action: 'swap',
      chain: 'ethereum',
      network: 'arbitrum',
      sellToken: 'USDC',
      buyToken: 'ETH',
      sellAmount: '1',
    })))

    assert.equal(approvalRequest.type, 'plugin_wallet_action_request')
    assert.equal(approvalRequest.action, 'swap')

    const approvals = storage.loadApprovals()
    const pending: any = approvalRequest.approvalId ? approvals[approvalRequest.approvalId] : undefined
    assert.ok(pending)
    assert.equal(pending?.status, 'pending')
    assert.equal(String(pending?.data.amountAtomic), '1000000')
    assert.equal(String(pending?.data.network), 'arbitrum')
    assert.equal(String(pending?.data.sellToken).toLowerCase(), '0xaf88d065e77c8cc2239327c5edb3a432268e5831')
    assert.equal(String(pending?.data.buyToken).toLowerCase(), '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
  })
})
