import type { WalletChain } from '@/types'

export const SUPPORTED_WALLET_CHAINS = ['solana', 'ethereum'] as const

export interface WalletChainMeta {
  chain: WalletChain
  label: string
  symbol: string
  decimals: number
  defaultPerTxAtomic: string
  defaultDailyAtomic: string
  addressExplorerBaseUrl: string
  transactionExplorerBaseUrl: string
  createDescription: string
  fundingInstructions: string[]
}

const WALLET_CHAIN_META: Record<WalletChain, WalletChainMeta> = {
  solana: {
    chain: 'solana',
    label: 'Solana',
    symbol: 'SOL',
    decimals: 9,
    defaultPerTxAtomic: '100000000',
    defaultDailyAtomic: '1000000000',
    addressExplorerBaseUrl: 'https://solscan.io/account/',
    transactionExplorerBaseUrl: 'https://solscan.io/tx/',
    createDescription: 'Create a Solana wallet for agents that need SOL-native transfers and Solana ecosystem access.',
    fundingInstructions: [
      'Send SOL to this wallet address from any Solana wallet or exchange.',
      'Make sure you are sending real SOL on Solana mainnet.',
    ],
  },
  ethereum: {
    chain: 'ethereum',
    label: 'Ethereum',
    symbol: 'ETH',
    decimals: 18,
    defaultPerTxAtomic: '10000000000000000',
    defaultDailyAtomic: '50000000000000000',
    addressExplorerBaseUrl: 'https://etherscan.io/address/',
    transactionExplorerBaseUrl: 'https://etherscan.io/tx/',
    createDescription: 'Create an Ethereum-compatible EVM wallet for ETH-native transfers, exchange auth, and EVM ecosystem access.',
    fundingInstructions: [
      'Send ETH to this wallet address from any Ethereum-compatible wallet or exchange.',
      'Make sure the sending network matches the wallet network you intend to use before transferring funds.',
    ],
  },
}

export function getWalletChainMeta(chain: WalletChain): WalletChainMeta {
  return WALLET_CHAIN_META[chain] || WALLET_CHAIN_META.solana
}

export function normalizeWalletChainInput(value: unknown): WalletChain | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'sol' || normalized === 'solana') return 'solana'
  if (normalized === 'eth' || normalized === 'ethereum' || normalized === 'evm') {
    return 'ethereum'
  }
  return null
}

export function getWalletChainOrDefault(value: unknown, fallback: WalletChain = 'solana'): WalletChain {
  const normalized = normalizeWalletChainInput(value)
  if (normalized) return normalized
  const raw = String(value ?? '').trim()
  if (raw) {
    throw new Error(`Unsupported wallet chain or provider: ${raw}`)
  }
  return fallback
}

export function getWalletDefaultLimitAtomic(chain: WalletChain, limit: 'perTx' | 'daily'): string {
  const meta = getWalletChainMeta(chain)
  return limit === 'perTx' ? meta.defaultPerTxAtomic : meta.defaultDailyAtomic
}

export function normalizeAtomicString(value: unknown, fallback = '0'): string {
  if (typeof value === 'bigint') return value >= BigInt(0) ? value.toString() : fallback
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value).toString()
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^\d+$/.test(trimmed)) return trimmed.replace(/^0+(?=\d)/, '') || '0'
  }
  return fallback
}

export function parseDisplayAmountToAtomic(value: string | number, decimals: number): string {
  const raw = typeof value === 'number'
    ? value.toLocaleString('en-US', {
      useGrouping: false,
      maximumFractionDigits: decimals,
    }).trim()
    : String(value ?? '').trim()
  if (!raw) throw new Error('Amount is required')
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error('Amount must be a positive decimal number')

  const [whole, fraction = ''] = raw.split('.')
  if (fraction.length > decimals) {
    throw new Error(`Amount supports up to ${decimals} decimal places`)
  }

  const wholePart = BigInt(whole || '0')
  const fractionPadded = `${fraction}${'0'.repeat(decimals)}`.slice(0, decimals)
  const fractionPart = BigInt(fractionPadded || '0')
  const scale = BigInt(10) ** BigInt(decimals)
  return ((wholePart * scale) + fractionPart).toString()
}

export function formatAtomicAmount(
  atomicValue: string | number | bigint,
  decimals: number,
  opts?: { minFractionDigits?: number; maxFractionDigits?: number }
): string {
  const atomic = BigInt(normalizeAtomicString(atomicValue, '0'))
  const scale = BigInt(10) ** BigInt(decimals)
  const whole = atomic / scale
  const fraction = atomic % scale
  const maxFractionDigits = Math.max(0, Math.min(decimals, opts?.maxFractionDigits ?? decimals))
  const minFractionDigits = Math.max(0, Math.min(maxFractionDigits, opts?.minFractionDigits ?? 0))

  if (maxFractionDigits === 0) return whole.toString()

  let fractionText = fraction.toString().padStart(decimals, '0').slice(0, maxFractionDigits)
  if (fractionText.length < minFractionDigits) fractionText = fractionText.padEnd(minFractionDigits, '0')
  if (fractionText.length > minFractionDigits) fractionText = fractionText.replace(/0+$/, '')
  if (fractionText.length < minFractionDigits) fractionText = fractionText.padEnd(minFractionDigits, '0')

  return fractionText.length > 0 ? `${whole.toString()}.${fractionText}` : whole.toString()
}

export function formatWalletAmount(
  chain: WalletChain,
  atomicValue: string | number | bigint,
  opts?: { minFractionDigits?: number; maxFractionDigits?: number }
): string {
  return formatAtomicAmount(atomicValue, getWalletChainMeta(chain).decimals, opts)
}

export function getWalletExplorerUrl(chain: WalletChain, kind: 'address' | 'transaction', value: string): string {
  const meta = getWalletChainMeta(chain)
  const base = kind === 'address' ? meta.addressExplorerBaseUrl : meta.transactionExplorerBaseUrl
  return `${base}${value}`
}

export function getWalletAssetSymbol(chain: WalletChain): string {
  return getWalletChainMeta(chain).symbol
}

export function getWalletAtomicAmount(value: { amountAtomic?: string; amountLamports?: number } | null | undefined): string {
  if (!value) return '0'
  return normalizeAtomicString(value.amountAtomic, normalizeAtomicString(value.amountLamports, '0'))
}

export function getWalletFeeAtomicAmount(value: { feeAtomic?: string; feeLamports?: number } | null | undefined): string {
  if (!value) return '0'
  return normalizeAtomicString(value.feeAtomic, normalizeAtomicString(value.feeLamports, '0'))
}

export function getWalletLimitAtomic(
  wallet: { chain: WalletChain; spendingLimitAtomic?: string; spendingLimitLamports?: number; dailyLimitAtomic?: string; dailyLimitLamports?: number },
  limit: 'perTx' | 'daily',
): string {
  if (limit === 'perTx') {
    return normalizeAtomicString(
      wallet.spendingLimitAtomic,
      normalizeAtomicString(wallet.spendingLimitLamports, getWalletDefaultLimitAtomic(wallet.chain, 'perTx')),
    )
  }
  return normalizeAtomicString(
    wallet.dailyLimitAtomic,
    normalizeAtomicString(wallet.dailyLimitLamports, getWalletDefaultLimitAtomic(wallet.chain, 'daily')),
  )
}

export function getWalletBalanceAtomic(
  wallet: { balanceAtomic?: string; balanceLamports?: number | null } | null | undefined,
): string {
  if (!wallet) return '0'
  return normalizeAtomicString(wallet.balanceAtomic, normalizeAtomicString(wallet.balanceLamports, '0'))
}
