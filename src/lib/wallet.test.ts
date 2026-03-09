import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeWalletChainInput,
  getWalletChainOrDefault,
  normalizeAtomicString,
  parseDisplayAmountToAtomic,
  formatAtomicAmount,
  formatWalletAmount,
  getWalletChainMeta,
  getWalletDefaultLimitAtomic,
  getWalletExplorerUrl,
  getWalletAssetSymbol,
  getWalletAtomicAmount,
  getWalletFeeAtomicAmount,
  getWalletLimitAtomic,
  getWalletBalanceAtomic,
} from './wallet'

describe('normalizeWalletChainInput', () => {
  it('normalizes solana variants', () => {
    assert.equal(normalizeWalletChainInput('solana'), 'solana')
    assert.equal(normalizeWalletChainInput('Solana'), 'solana')
    assert.equal(normalizeWalletChainInput('SOL'), 'solana')
    assert.equal(normalizeWalletChainInput('sol'), 'solana')
    assert.equal(normalizeWalletChainInput('  sol  '), 'solana')
  })

  it('normalizes ethereum variants', () => {
    assert.equal(normalizeWalletChainInput('ethereum'), 'ethereum')
    assert.equal(normalizeWalletChainInput('Ethereum'), 'ethereum')
    assert.equal(normalizeWalletChainInput('ETH'), 'ethereum')
    assert.equal(normalizeWalletChainInput('eth'), 'ethereum')
    assert.equal(normalizeWalletChainInput('evm'), 'ethereum')
    assert.equal(normalizeWalletChainInput('EVM'), 'ethereum')
  })

  it('returns null for unsupported or empty input', () => {
    assert.equal(normalizeWalletChainInput('bitcoin'), null)
    assert.equal(normalizeWalletChainInput(''), null)
    assert.equal(normalizeWalletChainInput(null), null)
    assert.equal(normalizeWalletChainInput(undefined), null)
    assert.equal(normalizeWalletChainInput(0), null)
    assert.equal(normalizeWalletChainInput(false), null)
  })
})

describe('getWalletChainOrDefault', () => {
  it('returns recognized chain', () => {
    assert.equal(getWalletChainOrDefault('sol'), 'solana')
    assert.equal(getWalletChainOrDefault('eth'), 'ethereum')
  })

  it('returns fallback for empty/null/undefined', () => {
    assert.equal(getWalletChainOrDefault(''), 'solana')
    assert.equal(getWalletChainOrDefault(null), 'solana')
    assert.equal(getWalletChainOrDefault(undefined), 'solana')
    assert.equal(getWalletChainOrDefault(undefined, 'ethereum'), 'ethereum')
  })

  it('throws for unrecognized non-empty value', () => {
    assert.throws(() => getWalletChainOrDefault('bitcoin'), /Unsupported wallet chain/)
    assert.throws(() => getWalletChainOrDefault('base'), /Unsupported wallet chain or provider: base/)
    assert.throws(() => getWalletChainOrDefault('ethereun'), /Unsupported wallet chain or provider: ethereun/)
  })
})

describe('normalizeAtomicString', () => {
  it('handles string integers', () => {
    assert.equal(normalizeAtomicString('12345'), '12345')
    assert.equal(normalizeAtomicString('0'), '0')
    assert.equal(normalizeAtomicString('007'), '7')
    assert.equal(normalizeAtomicString('0000'), '0')
  })

  it('handles bigint', () => {
    assert.equal(normalizeAtomicString(BigInt(999)), '999')
    assert.equal(normalizeAtomicString(BigInt(0)), '0')
    assert.equal(normalizeAtomicString(BigInt(-5)), '0')
    assert.equal(normalizeAtomicString(BigInt(-1), 'fallback'), 'fallback')
  })

  it('handles number', () => {
    assert.equal(normalizeAtomicString(100), '100')
    assert.equal(normalizeAtomicString(3.9), '3')
    assert.equal(normalizeAtomicString(0), '0')
  })

  it('returns fallback for invalid input', () => {
    assert.equal(normalizeAtomicString('abc'), '0')
    assert.equal(normalizeAtomicString('12.5'), '0')
    assert.equal(normalizeAtomicString(-1), '0')
    assert.equal(normalizeAtomicString(NaN), '0')
    assert.equal(normalizeAtomicString(Infinity), '0')
    assert.equal(normalizeAtomicString(null), '0')
    assert.equal(normalizeAtomicString(undefined), '0')
    assert.equal(normalizeAtomicString('  '), '0')
    assert.equal(normalizeAtomicString(null, 'custom'), 'custom')
  })

  it('strips leading zeros from strings', () => {
    assert.equal(normalizeAtomicString('00100'), '100')
    assert.equal(normalizeAtomicString('00'), '0')
  })
})

describe('parseDisplayAmountToAtomic', () => {
  it('converts whole numbers (SOL, 9 decimals)', () => {
    assert.equal(parseDisplayAmountToAtomic('1', 9), '1000000000')
    assert.equal(parseDisplayAmountToAtomic('0', 9), '0')
    assert.equal(parseDisplayAmountToAtomic('100', 9), '100000000000')
  })

  it('converts fractional numbers (SOL)', () => {
    assert.equal(parseDisplayAmountToAtomic('0.1', 9), '100000000')
    assert.equal(parseDisplayAmountToAtomic('1.5', 9), '1500000000')
    assert.equal(parseDisplayAmountToAtomic('0.000000001', 9), '1')
  })

  it('converts with ETH decimals (18)', () => {
    assert.equal(parseDisplayAmountToAtomic('1', 18), '1000000000000000000')
    assert.equal(parseDisplayAmountToAtomic('0.01', 18), '10000000000000000')
    assert.equal(parseDisplayAmountToAtomic('0.000000000000000001', 18), '1')
  })

  it('accepts number input', () => {
    assert.equal(parseDisplayAmountToAtomic(1.5, 9), '1500000000')
    assert.equal(parseDisplayAmountToAtomic(0, 9), '0')
    assert.equal(parseDisplayAmountToAtomic(0.000000000000000001, 18), '1')
  })

  it('throws for empty amount', () => {
    assert.throws(() => parseDisplayAmountToAtomic('', 9), /Amount is required/)
  })

  it('throws for non-numeric strings', () => {
    assert.throws(() => parseDisplayAmountToAtomic('abc', 9), /Amount must be a positive decimal/)
    assert.throws(() => parseDisplayAmountToAtomic('-1', 9), /Amount must be a positive decimal/)
  })

  it('throws for too many decimal places', () => {
    assert.throws(() => parseDisplayAmountToAtomic('1.0000000001', 9), /up to 9 decimal places/)
  })
})

describe('formatAtomicAmount', () => {
  it('formats SOL (9 decimals)', () => {
    assert.equal(formatAtomicAmount('1000000000', 9), '1')
    assert.equal(formatAtomicAmount('1500000000', 9), '1.5')
    assert.equal(formatAtomicAmount('100000000', 9), '0.1')
    assert.equal(formatAtomicAmount('1', 9), '0.000000001')
    assert.equal(formatAtomicAmount('0', 9), '0')
  })

  it('formats ETH (18 decimals)', () => {
    assert.equal(formatAtomicAmount('1000000000000000000', 18), '1')
    assert.equal(formatAtomicAmount('10000000000000000', 18), '0.01')
  })

  it('respects minFractionDigits', () => {
    assert.equal(formatAtomicAmount('1000000000', 9, { minFractionDigits: 2 }), '1.00')
    assert.equal(formatAtomicAmount('1500000000', 9, { minFractionDigits: 4 }), '1.5000')
  })

  it('respects maxFractionDigits', () => {
    assert.equal(formatAtomicAmount('1', 9, { maxFractionDigits: 2 }), '0')
    assert.equal(formatAtomicAmount('1000000000', 9, { maxFractionDigits: 0 }), '1')
  })

  it('handles bigint input', () => {
    assert.equal(formatAtomicAmount(BigInt('1000000000'), 9), '1')
  })

  it('handles number input', () => {
    assert.equal(formatAtomicAmount(1000000000, 9), '1')
  })
})

describe('formatWalletAmount', () => {
  it('uses chain-specific decimals', () => {
    assert.equal(formatWalletAmount('solana', '1000000000'), '1')
    assert.equal(formatWalletAmount('ethereum', '1000000000000000000'), '1')
  })
})

describe('getWalletChainMeta', () => {
  it('returns solana metadata', () => {
    const meta = getWalletChainMeta('solana')
    assert.equal(meta.symbol, 'SOL')
    assert.equal(meta.decimals, 9)
    assert.equal(meta.chain, 'solana')
  })

  it('returns ethereum metadata', () => {
    const meta = getWalletChainMeta('ethereum')
    assert.equal(meta.symbol, 'ETH')
    assert.equal(meta.decimals, 18)
  })

  it('falls back to solana for unknown chain', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = getWalletChainMeta('unknown' as any)
    assert.equal(meta.chain, 'solana')
  })
})

describe('getWalletDefaultLimitAtomic', () => {
  it('returns perTx and daily defaults', () => {
    assert.equal(getWalletDefaultLimitAtomic('solana', 'perTx'), '100000000')
    assert.equal(getWalletDefaultLimitAtomic('solana', 'daily'), '1000000000')
    assert.equal(getWalletDefaultLimitAtomic('ethereum', 'perTx'), '10000000000000000')
    assert.equal(getWalletDefaultLimitAtomic('ethereum', 'daily'), '50000000000000000')
  })
})

describe('getWalletExplorerUrl', () => {
  it('builds address explorer URLs', () => {
    assert.equal(
      getWalletExplorerUrl('solana', 'address', 'abc123'),
      'https://solscan.io/account/abc123',
    )
    assert.equal(
      getWalletExplorerUrl('ethereum', 'address', '0xdef'),
      'https://etherscan.io/address/0xdef',
    )
  })

  it('builds transaction explorer URLs', () => {
    assert.equal(
      getWalletExplorerUrl('solana', 'transaction', 'tx1'),
      'https://solscan.io/tx/tx1',
    )
    assert.equal(
      getWalletExplorerUrl('ethereum', 'transaction', '0xtx'),
      'https://etherscan.io/tx/0xtx',
    )
  })
})

describe('getWalletAssetSymbol', () => {
  it('returns chain symbols', () => {
    assert.equal(getWalletAssetSymbol('solana'), 'SOL')
    assert.equal(getWalletAssetSymbol('ethereum'), 'ETH')
  })
})

describe('getWalletAtomicAmount', () => {
  it('prefers amountAtomic', () => {
    assert.equal(getWalletAtomicAmount({ amountAtomic: '500' }), '500')
  })

  it('falls back to amountLamports', () => {
    assert.equal(getWalletAtomicAmount({ amountLamports: 300 }), '300')
  })

  it('returns 0 for null/undefined', () => {
    assert.equal(getWalletAtomicAmount(null), '0')
    assert.equal(getWalletAtomicAmount(undefined), '0')
  })

  it('returns 0 for empty object', () => {
    assert.equal(getWalletAtomicAmount({}), '0')
  })
})

describe('getWalletFeeAtomicAmount', () => {
  it('prefers feeAtomic', () => {
    assert.equal(getWalletFeeAtomicAmount({ feeAtomic: '5000' }), '5000')
  })

  it('falls back to feeLamports', () => {
    assert.equal(getWalletFeeAtomicAmount({ feeLamports: 5000 }), '5000')
  })

  it('returns 0 for null/undefined', () => {
    assert.equal(getWalletFeeAtomicAmount(null), '0')
    assert.equal(getWalletFeeAtomicAmount(undefined), '0')
  })
})

describe('getWalletLimitAtomic', () => {
  it('uses spendingLimitAtomic for perTx', () => {
    assert.equal(
      getWalletLimitAtomic({ chain: 'solana', spendingLimitAtomic: '50000' }, 'perTx'),
      '50000',
    )
  })

  it('falls back to spendingLimitLamports then default for perTx', () => {
    assert.equal(
      getWalletLimitAtomic({ chain: 'solana', spendingLimitLamports: 25000 }, 'perTx'),
      '25000',
    )
    assert.equal(
      getWalletLimitAtomic({ chain: 'solana' }, 'perTx'),
      '100000000',
    )
  })

  it('uses dailyLimitAtomic for daily', () => {
    assert.equal(
      getWalletLimitAtomic({ chain: 'ethereum', dailyLimitAtomic: '99999' }, 'daily'),
      '99999',
    )
  })

  it('falls back for daily', () => {
    assert.equal(
      getWalletLimitAtomic({ chain: 'ethereum' }, 'daily'),
      '50000000000000000',
    )
  })
})

describe('getWalletBalanceAtomic', () => {
  it('prefers balanceAtomic', () => {
    assert.equal(getWalletBalanceAtomic({ balanceAtomic: '12345' }), '12345')
  })

  it('falls back to balanceLamports', () => {
    assert.equal(getWalletBalanceAtomic({ balanceLamports: 9999 }), '9999')
  })

  it('returns 0 for null/undefined/empty', () => {
    assert.equal(getWalletBalanceAtomic(null), '0')
    assert.equal(getWalletBalanceAtomic(undefined), '0')
    assert.equal(getWalletBalanceAtomic({}), '0')
  })

  it('handles null balanceLamports', () => {
    assert.equal(getWalletBalanceAtomic({ balanceLamports: null }), '0')
  })
})
