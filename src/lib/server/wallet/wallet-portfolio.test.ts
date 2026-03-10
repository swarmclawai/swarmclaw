import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentWallet } from '@/types'

import {
  buildLogDiscoveryRanges,
  estimateDiscoveryStartBlock,
  getKnownEvmTokenContracts,
  parseMetaplexMetadataFields,
  buildEmptyWalletPortfolio,
  resolveWalletPortfolioWithTimeout,
} from '@/lib/server/wallet/wallet-portfolio'

describe('wallet portfolio helpers', () => {
  it('splits large log discovery requests into provider-safe chunks', () => {
    assert.deepEqual(buildLogDiscoveryRanges(10, 10, 50_000), [{ fromBlock: 10, toBlock: 10 }])
    assert.deepEqual(buildLogDiscoveryRanges(1, 120_000, 50_000), [
      { fromBlock: 1, toBlock: 50_000 },
      { fromBlock: 50_001, toBlock: 100_000 },
      { fromBlock: 100_001, toBlock: 120_000 },
    ])
  })

  it('always checks canonical USDC contracts on supported EVM networks', () => {
    assert.equal(
      getKnownEvmTokenContracts('arbitrum').map((address) => address.toLowerCase()).includes('0xaf88d065e77c8cc2239327c5edb3a432268e5831'),
      true,
    )
    assert.equal(
      getKnownEvmTokenContracts('base').map((address) => address.toLowerCase()).includes('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
      true,
    )
    assert.equal(
      getKnownEvmTokenContracts('ethereum').map((address) => address.toLowerCase()).includes('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
      true,
    )
  })

  it('scans from wallet age rather than capping discovery to a fixed recent window', () => {
    const now = Date.UTC(2026, 2, 8)
    const latestBlock = 10_000_000
    const newerWalletStart = estimateDiscoveryStartBlock({
      latestBlock,
      walletCreatedAt: now - (7 * 24 * 60 * 60 * 1000),
      avgBlockMs: 12_000,
      maxDiscoveryBlocks: 5_000_000,
      now,
    })
    const olderWalletStart = estimateDiscoveryStartBlock({
      latestBlock,
      walletCreatedAt: now - (30 * 24 * 60 * 60 * 1000),
      avgBlockMs: 12_000,
      maxDiscoveryBlocks: 5_000_000,
      now,
    })

    assert.equal(olderWalletStart < newerWalletStart, true)
  })

  it('parses metaplex metadata name and symbol for arbitrary SPL mints', () => {
    const data = Buffer.alloc(1 + 32 + 32 + 32 + 10)
    Buffer.from('Example Token').copy(data, 1 + 32 + 32)
    Buffer.from('EXMPL').copy(data, 1 + 32 + 32 + 32)

    assert.deepEqual(parseMetaplexMetadataFields(data), {
      name: 'Example Token',
      symbol: 'EXMPL',
    })
  })

  it('returns stale portfolio data when a live portfolio lookup times out', async () => {
    const wallet: AgentWallet = {
      id: 'wallet-timeout',
      agentId: 'agent-timeout',
      chain: 'ethereum',
      publicKey: '0x0000000000000000000000000000000000000001',
      encryptedPrivateKey: 'secret',
      requireApproval: true,
      spendingLimitAtomic: '1',
      dailyLimitAtomic: '1',
      createdAt: 1,
      updatedAt: 1,
    }
    const stale = buildEmptyWalletPortfolio(wallet)
    stale.balanceAtomic = '123'
    stale.balanceFormatted = '0.000000000000000123'
    stale.balanceDisplay = `${stale.balanceFormatted} ETH`

    const result = await resolveWalletPortfolioWithTimeout({
      load: () => new Promise<ReturnType<typeof buildEmptyWalletPortfolio>>(() => {}),
      timeoutMs: 5,
      stale,
      label: 'wallet portfolio timeout test',
    })

    assert.equal(result.balanceAtomic, '123')
  })
})
