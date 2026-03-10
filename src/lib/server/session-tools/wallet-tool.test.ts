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
let createAgentWallet: typeof import('@/lib/server/wallet/wallet-service').createAgentWallet
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
  ;({ createAgentWallet } = await import('@/lib/server/wallet/wallet-service'))
  storage = await import('../storage')
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
  it('signs messages directly without creating approval records', async () => {
    createAgentWallet({ agentId: 'agent_wallet', chain: 'ethereum' })
    const session = makeSession()
    const [walletTool] = buildWalletTools(makeBuildContext(session))

    const result = JSON.parse(String(await walletTool.invoke({
      action: 'sign_message',
      chain: 'ethereum',
      message: 'sign me',
    })))

    assert.equal(result.status, 'signed')
    assert.equal(result.chain, 'ethereum')
    assert.equal(typeof result.signature, 'string')

    const approvals = storage.loadApprovals()
    const walletApprovals = Object.values(approvals).filter((approval: any) => approval.category === 'wallet_action')
    assert.equal(walletApprovals.length, 0)
  })

  it('ignores legacy approval fields and still encodes contract calls', async () => {
    const session = makeSession()
    const [walletTool] = buildWalletTools(makeBuildContext(session))

    const signResult = JSON.parse(String(await walletTool.invoke({
      action: 'sign_message',
      chain: 'ethereum',
      message: 'signed',
      approved: true,
      approvalId: 'legacy-approval-id',
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
})
