import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { WalletTransaction } from '@/types'

import {
  filterWalletTransactions,
  getWalletTransactionStatusGroup,
  matchesWalletTransactionFilter,
  matchesWalletTransactionQuery,
} from '@/lib/wallet/wallet-transactions'

function buildTransaction(overrides: Partial<WalletTransaction> = {}): WalletTransaction {
  return {
    id: 'tx-1',
    walletId: 'wallet-1',
    agentId: 'agent-1',
    chain: 'ethereum',
    type: 'swap',
    signature: '0xabc123',
    fromAddress: '0xfrom000000000000000000000000000000000001',
    toAddress: '0xto0000000000000000000000000000000000002',
    amountAtomic: '1000000',
    status: 'confirmed',
    memo: 'Swapped 1 USDC to ETH',
    timestamp: 1,
    ...overrides,
  }
}

describe('wallet transaction filters', () => {
  it('groups pending and pending_approval together', () => {
    assert.equal(getWalletTransactionStatusGroup('pending'), 'pending')
    assert.equal(getWalletTransactionStatusGroup('pending_approval'), 'pending')
    assert.equal(getWalletTransactionStatusGroup('confirmed'), 'confirmed')
    assert.equal(getWalletTransactionStatusGroup('failed'), 'failed')
    assert.equal(getWalletTransactionStatusGroup('denied'), 'failed')
  })

  it('matches filters by type and status group', () => {
    assert.equal(matchesWalletTransactionFilter(buildTransaction({ type: 'swap' }), 'swap'), true)
    assert.equal(matchesWalletTransactionFilter(buildTransaction({ type: 'send' }), 'send'), true)
    assert.equal(matchesWalletTransactionFilter(buildTransaction({ status: 'pending_approval' }), 'pending'), true)
    assert.equal(matchesWalletTransactionFilter(buildTransaction({ status: 'denied' }), 'failed'), true)
  })

  it('matches search queries against signature, memo, and addresses', () => {
    const tx = buildTransaction()
    assert.equal(matchesWalletTransactionQuery(tx, 'usdc'), true)
    assert.equal(matchesWalletTransactionQuery(tx, '0xabc123'), true)
    assert.equal(matchesWalletTransactionQuery(tx, '0xfrom0000'), true)
    assert.equal(matchesWalletTransactionQuery(tx, 'missing-text'), false)
  })

  it('filters transactions by combined status/type and search query', () => {
    const transactions = [
      buildTransaction({ id: 'tx-confirmed', status: 'confirmed', memo: 'Swap USDC to ETH' }),
      buildTransaction({ id: 'tx-pending', status: 'pending_approval', memo: 'Awaiting approval' }),
      buildTransaction({ id: 'tx-send', type: 'send', status: 'confirmed', memo: 'Send ETH to treasury' }),
    ]

    assert.deepEqual(
      filterWalletTransactions(transactions, { filter: 'pending' }).map((tx) => tx.id),
      ['tx-pending'],
    )
    assert.deepEqual(
      filterWalletTransactions(transactions, { filter: 'send', query: 'treasury' }).map((tx) => tx.id),
      ['tx-send'],
    )
    assert.deepEqual(
      filterWalletTransactions(transactions, { filter: 'confirmed', query: 'usdc' }).map((tx) => tx.id),
      ['tx-confirmed'],
    )
  })
})
