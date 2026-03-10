import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AgentWallet, WalletTransaction } from '@/types'

import { validateWalletSendLimits } from '@/lib/server/wallet/wallet-service'

function buildWallet(overrides: Partial<AgentWallet> = {}): AgentWallet {
  return {
    id: 'wallet-1',
    agentId: 'agent-1',
    chain: 'ethereum',
    publicKey: '0x0000000000000000000000000000000000000001',
    encryptedPrivateKey: 'secret',
    requireApproval: true,
    spendingLimitAtomic: '1000000000000000000',
    dailyLimitAtomic: '1500000000000000000',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function buildTransaction(overrides: Partial<WalletTransaction> = {}): WalletTransaction {
  return {
    id: 'tx-1',
    walletId: 'wallet-1',
    agentId: 'agent-1',
    chain: 'ethereum',
    type: 'send',
    signature: '0xhash',
    fromAddress: '0xfrom',
    toAddress: '0xto',
    amountAtomic: '1000000000000000000',
    status: 'confirmed',
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('validateWalletSendLimits', () => {
  it('blocks approvals that would exceed the current daily limit', () => {
    const wallet = buildWallet()
    const transactions = [
      buildTransaction({ id: 'existing', amountAtomic: '1000000000000000000' }),
    ]

    const error = validateWalletSendLimits({
      wallet,
      amountAtomic: '600000000000000000',
      transactions,
      now: Date.now(),
    })

    assert.match(error || '', /Daily limit exceeded/)
  })
})
