import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getWalletChainOrDefault, parseDisplayAmountToAtomic } from './wallet'

describe('wallet helpers', () => {
  it('rejects unsupported wallet chain aliases instead of silently remapping them', () => {
    assert.throws(() => getWalletChainOrDefault('base'), /Unsupported wallet chain or provider: base/)
    assert.throws(() => getWalletChainOrDefault('ethereun'), /Unsupported wallet chain or provider: ethereun/)
    assert.equal(getWalletChainOrDefault(undefined), 'solana')
  })

  it('parses tiny ETH amounts from either strings or numbers', () => {
    assert.equal(parseDisplayAmountToAtomic('0.000000000000000001', 18), '1')
    assert.equal(parseDisplayAmountToAtomic(0.000000000000000001, 18), '1')
  })
})
