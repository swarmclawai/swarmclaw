import { Contract, Interface, JsonRpcProvider, getAddress, zeroPadValue } from 'ethers'
import { PublicKey } from '@solana/web3.js'

import { formatAtomicAmount, getWalletAssetSymbol } from '@/lib/wallet/wallet'
import type { AgentWallet, WalletAssetBalance, WalletPortfolioSummary } from '@/types'

import { getProvider as getEthereumProvider } from '@/lib/server/ethereum'
import { getConnection as getSolanaConnection } from '@/lib/server/solana'

const TOKEN_PROGRAM_IDS = [
  new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
] as const
const METAPLEX_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')

const SOLSCAN_ACCOUNT_BASE = 'https://solscan.io/account/'
const SOLSCAN_TOKEN_BASE = 'https://solscan.io/token/'
const ERC20_TRANSFER_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])
const ERC20_TRANSFER_TOPIC = ERC20_TRANSFER_IFACE.getEvent('Transfer')?.topicHash || ''
const ERC20_SYMBOL_BYTES32_IFACE = new Interface(['function symbol() view returns (bytes32)'])
const ERC20_NAME_BYTES32_IFACE = new Interface(['function name() view returns (bytes32)'])
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
] as const
const PORTFOLIO_CACHE_TTL_MS = 20_000
const SOLANA_RPC_MIN_INTERVAL_MS = 500
let lastSolanaRpcCall = 0
const EVM_CONTRACT_CACHE_TTL_MS = 10 * 60 * 1000
const SOLANA_METADATA_BATCH_SIZE = 100
const TOKEN_METADATA_NAME_OFFSET = 1 + 32 + 32
const TOKEN_METADATA_NAME_LENGTH = 32
const TOKEN_METADATA_SYMBOL_OFFSET = TOKEN_METADATA_NAME_OFFSET + TOKEN_METADATA_NAME_LENGTH
const TOKEN_METADATA_SYMBOL_LENGTH = 10

interface WalletPortfolioCacheEntry {
  expiresAt: number
  portfolio: WalletPortfolio
}

interface EvmContractDiscoveryCacheEntry {
  expiresAt: number
  walletCreatedAt: number
  scannedToBlock: number
  contractAddresses: string[]
}

interface EvmNetworkConfig {
  id: string
  label: string
  rpcUrl: string
  addressExplorerBaseUrl: string
  tokenExplorerBaseUrl: string
  avgBlockMs: number
  maxDiscoveryBlocks: number
  maxLogRange?: number
  knownTokens?: KnownEvmTokenConfig[]
}

interface KnownEvmTokenConfig {
  address: string
  symbol: string
  name: string
  decimals: number
}

export interface WalletPortfolio {
  balanceAtomic: string
  balanceFormatted: string
  balanceSymbol: string
  balanceDisplay: string
  balanceLamports?: number
  balanceSol?: number
  assets: WalletAssetBalance[]
  summary: WalletPortfolioSummary
}

export interface GetWalletPortfolioOptions {
  timeoutMs?: number
  allowStale?: boolean
}

const portfolioCache = new Map<string, WalletPortfolioCacheEntry>()
const evmContractDiscoveryCache = new Map<string, EvmContractDiscoveryCacheEntry>()

const KNOWN_SOLANA_TOKENS: Record<string, { symbol: string; name: string }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', name: 'USD Coin' },
}

const KNOWN_EVM_TOKENS: Record<string, KnownEvmTokenConfig[]> = {
  ethereum: [
    {
      address: getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
  arbitrum: [
    {
      address: getAddress('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
  base: [
    {
      address: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
}

function getEnabledEvmNetworks(): EvmNetworkConfig[] {
  return [
    {
      id: 'ethereum',
      label: 'Ethereum',
      rpcUrl: process.env.ETHEREUM_RPC_URL || process.env.EVM_RPC_URL || 'https://ethereum-rpc.publicnode.com',
      addressExplorerBaseUrl: 'https://etherscan.io/address/',
      tokenExplorerBaseUrl: 'https://etherscan.io/token/',
      avgBlockMs: 12_000,
      maxDiscoveryBlocks: 300_000,
      maxLogRange: 50_000,
      knownTokens: KNOWN_EVM_TOKENS.ethereum,
    },
    {
      id: 'arbitrum',
      label: 'Arbitrum',
      rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arbitrum-one-rpc.publicnode.com',
      addressExplorerBaseUrl: 'https://arbiscan.io/address/',
      tokenExplorerBaseUrl: 'https://arbiscan.io/token/',
      avgBlockMs: 250,
      maxDiscoveryBlocks: 2_000_000,
      maxLogRange: 50_000,
      knownTokens: KNOWN_EVM_TOKENS.arbitrum,
    },
    {
      id: 'base',
      label: 'Base',
      rpcUrl: process.env.BASE_RPC_URL || 'https://base-rpc.publicnode.com',
      addressExplorerBaseUrl: 'https://basescan.org/address/',
      tokenExplorerBaseUrl: 'https://basescan.org/token/',
      avgBlockMs: 2_000,
      maxDiscoveryBlocks: 800_000,
      maxLogRange: 50_000,
      knownTokens: KNOWN_EVM_TOKENS.base,
    },
  ].filter((network) => Boolean(network.rpcUrl))
}

export function getKnownEvmTokenContracts(networkId: string): string[] {
  return (KNOWN_EVM_TOKENS[networkId] || []).map((token) => token.address)
}

export function estimateDiscoveryStartBlock(input: {
  latestBlock: number
  walletCreatedAt: number
  avgBlockMs: number
  maxDiscoveryBlocks: number
  now?: number
  safetyBlocks?: number
}): number {
  const now = input.now ?? Date.now()
  const safetyBlocks = input.safetyBlocks ?? 5_000
  const ageMs = Math.max(0, now - input.walletCreatedAt)
  const estimatedBlocks = Math.min(
    input.maxDiscoveryBlocks,
    Math.max(safetyBlocks, Math.ceil(ageMs / input.avgBlockMs) + safetyBlocks),
  )
  return Math.max(0, input.latestBlock - estimatedBlocks)
}

export function buildLogDiscoveryRanges(
  fromBlock: number,
  toBlock: number,
  maxLogRange?: number,
): Array<{ fromBlock: number; toBlock: number }> {
  if (toBlock < fromBlock) return []
  if (!maxLogRange || maxLogRange < 1 || toBlock - fromBlock + 1 <= maxLogRange) {
    return [{ fromBlock, toBlock }]
  }

  const ranges: Array<{ fromBlock: number; toBlock: number }> = []
  for (let start = fromBlock; start <= toBlock; start += maxLogRange) {
    ranges.push({
      fromBlock: start,
      toBlock: Math.min(toBlock, start + maxLogRange - 1),
    })
  }
  return ranges
}

function shortId(value: string): string {
  return value.length <= 10 ? value : `${value.slice(0, 4)}...${value.slice(-4)}`
}

function readFixedUtf8String(data: Uint8Array, offset: number, length: number): string {
  if (data.length < offset + length) return ''
  return Buffer.from(data.subarray(offset, offset + length))
    .toString('utf8')
    .replace(/\0/g, '')
    .trim()
}

export function parseMetaplexMetadataFields(data: Uint8Array): { name?: string; symbol?: string } | null {
  const name = readFixedUtf8String(data, TOKEN_METADATA_NAME_OFFSET, TOKEN_METADATA_NAME_LENGTH)
  const symbol = readFixedUtf8String(data, TOKEN_METADATA_SYMBOL_OFFSET, TOKEN_METADATA_SYMBOL_LENGTH)
  if (!name && !symbol) return null
  return {
    name: name || undefined,
    symbol: symbol || undefined,
  }
}

function getSolanaMetadataPda(mint: string): PublicKey | null {
  try {
    const mintKey = new PublicKey(mint)
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from('metadata'),
        METAPLEX_METADATA_PROGRAM_ID.toBuffer(),
        mintKey.toBuffer(),
      ],
      METAPLEX_METADATA_PROGRAM_ID,
    )[0]
  } catch {
    return null
  }
}

async function resolveSolanaMetadata(mints: string[]): Promise<Map<string, { name?: string; symbol?: string }>> {
  const result = new Map<string, { name?: string; symbol?: string }>()
  if (mints.length === 0) return result

  const connection = getSolanaConnection()
  const entries = mints
    .map((mint) => ({ mint, pda: getSolanaMetadataPda(mint) }))
    .filter((entry): entry is { mint: string; pda: PublicKey } => Boolean(entry.pda))

  for (let index = 0; index < entries.length; index += SOLANA_METADATA_BATCH_SIZE) {
    const batch = entries.slice(index, index + SOLANA_METADATA_BATCH_SIZE)
    try {
      const accounts = await rateLimitedSolanaCall(() => connection.getMultipleAccountsInfo(batch.map((entry) => entry.pda)))
      for (let accountIndex = 0; accountIndex < batch.length; accountIndex += 1) {
        const account = accounts[accountIndex]
        if (!account?.data) continue
        const parsed = parseMetaplexMetadataFields(account.data)
        if (!parsed) continue
        result.set(batch[accountIndex].mint, parsed)
      }
    } catch {
      continue
    }
  }

  return result
}

function normalizeAssetDisplay(
  symbol: string,
  balanceAtomic: string,
  decimals: number,
  opts?: { minFractionDigits?: number; maxFractionDigits?: number },
): { balanceFormatted: string; balanceDisplay: string } {
  const balanceFormatted = formatAtomicAmount(balanceAtomic, decimals, {
    minFractionDigits: opts?.minFractionDigits ?? 0,
    maxFractionDigits: opts?.maxFractionDigits ?? 6,
  })
  return {
    balanceFormatted,
    balanceDisplay: `${balanceFormatted} ${symbol}`,
  }
}

function buildPortfolioSummary(assets: WalletAssetBalance[]): WalletPortfolioSummary {
  const nonZeroAssets = assets.filter((asset) => BigInt(asset.balanceAtomic) > BigInt(0))
  return {
    totalAssets: assets.length,
    nonZeroAssets: nonZeroAssets.length,
    tokenAssets: assets.filter((asset) => !asset.isNative && BigInt(asset.balanceAtomic) > BigInt(0)).length,
    networkCount: new Set(nonZeroAssets.map((asset) => asset.networkId)).size,
  }
}

function sortAssets(assets: WalletAssetBalance[]): WalletAssetBalance[] {
  return [...assets].sort((left, right) => {
    const leftNonZero = BigInt(left.balanceAtomic) > BigInt(0)
    const rightNonZero = BigInt(right.balanceAtomic) > BigInt(0)
    if (leftNonZero !== rightNonZero) return leftNonZero ? -1 : 1
    if (left.isNative !== right.isNative) return left.isNative ? -1 : 1
    const networkCompare = left.networkLabel.localeCompare(right.networkLabel)
    if (networkCompare !== 0) return networkCompare
    return left.symbol.localeCompare(right.symbol)
  })
}

function buildPortfolioCacheKey(wallet: Pick<AgentWallet, 'id' | 'updatedAt'>): string {
  return `${wallet.id}:${wallet.updatedAt}`
}

function getCurrentCachedPortfolioEntry(wallet: Pick<AgentWallet, 'id' | 'updatedAt'>): WalletPortfolioCacheEntry | null {
  return portfolioCache.get(buildPortfolioCacheKey(wallet)) || null
}

function getLatestCachedPortfolioEntry(walletId: string): WalletPortfolioCacheEntry | null {
  let latest: WalletPortfolioCacheEntry | null = null
  for (const [key, entry] of portfolioCache.entries()) {
    if (!key.startsWith(`${walletId}:`)) continue
    if (!latest || entry.expiresAt > latest.expiresAt) latest = entry
  }
  return latest
}

export function getCachedWalletPortfolio(wallet: Pick<AgentWallet, 'id' | 'updatedAt'>): WalletPortfolio | null {
  return getCurrentCachedPortfolioEntry(wallet)?.portfolio
    || getLatestCachedPortfolioEntry(wallet.id)?.portfolio
    || null
}

async function withWalletPortfolioTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function buildEmptyWalletPortfolio(wallet: Pick<AgentWallet, 'chain' | 'publicKey'>): WalletPortfolio {
  const balanceSymbol = wallet.chain === 'ethereum' ? 'ETH' : 'SOL'
  const balanceDisplay = `0.0000 ${balanceSymbol}`
  return {
    balanceAtomic: '0',
    balanceFormatted: '0.0000',
    balanceDisplay,
    balanceSymbol,
    assets: [],
    summary: { totalAssets: 0, nonZeroAssets: 0, tokenAssets: 0, networkCount: 0 },
  }
}

export async function resolveWalletPortfolioWithTimeout<T>(
  params: {
    load: () => Promise<T>
    timeoutMs?: number
    stale?: T | null
    label: string
  },
): Promise<T> {
  try {
    if (typeof params.timeoutMs === 'number' && params.timeoutMs > 0) {
      return await withWalletPortfolioTimeout(params.load(), params.timeoutMs, params.label)
    }
    return await params.load()
  } catch (err) {
    if (params.stale != null) return params.stale
    throw err
  }
}

async function rateLimitedSolanaCall<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const elapsed = now - lastSolanaRpcCall
  if (elapsed < SOLANA_RPC_MIN_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, SOLANA_RPC_MIN_INTERVAL_MS - elapsed))
  }
  lastSolanaRpcCall = Date.now()
  return fn()
}

async function fetchSolanaAssets(wallet: AgentWallet): Promise<WalletPortfolio> {
  const connection = getSolanaConnection()
  const publicKey = new PublicKey(wallet.publicKey)
  const nativeBalanceAtomic = String(await rateLimitedSolanaCall(() => connection.getBalance(publicKey)))
  const nativeDisplay = normalizeAssetDisplay('SOL', nativeBalanceAtomic, 9, { minFractionDigits: 4 })
  const assets: WalletAssetBalance[] = [{
    id: `solana:mainnet:native`,
    chain: 'solana',
    networkId: 'solana-mainnet',
    networkLabel: 'Solana',
    symbol: 'SOL',
    name: 'Solana',
    decimals: 9,
    balanceAtomic: nativeBalanceAtomic,
    ...nativeDisplay,
    isNative: true,
    explorerUrl: `${SOLSCAN_ACCOUNT_BASE}${wallet.publicKey}`,
  }]

  const tokenAccounts = []
  for (const programId of TOKEN_PROGRAM_IDS) {
    tokenAccounts.push(await rateLimitedSolanaCall(() => connection.getParsedTokenAccountsByOwner(publicKey, { programId })))
  }

  const tokensByMint = new Map<string, WalletAssetBalance>()
  for (const result of tokenAccounts) {
    for (const account of result.value) {
      const parsed = (account.account.data as { parsed?: { info?: Record<string, unknown> } }).parsed
      const info = parsed?.info || {}
      const mint = typeof info.mint === 'string' ? info.mint : ''
      const tokenAmount = info.tokenAmount as { amount?: string; decimals?: number } | undefined
      const amountAtomic = String(tokenAmount?.amount || '0')
      if (!mint || BigInt(amountAtomic) <= BigInt(0)) continue
      const decimals = typeof tokenAmount?.decimals === 'number' ? tokenAmount.decimals : 0
      const known = KNOWN_SOLANA_TOKENS[mint]
      const symbol = known?.symbol || shortId(mint)
      const name = known?.name || `SPL Token ${shortId(mint)}`
      const display = normalizeAssetDisplay(symbol, amountAtomic, decimals)
      const existing = tokensByMint.get(mint)
      if (existing) {
        const nextAtomic = (BigInt(existing.balanceAtomic) + BigInt(amountAtomic)).toString()
        tokensByMint.set(mint, {
          ...existing,
          balanceAtomic: nextAtomic,
          ...normalizeAssetDisplay(existing.symbol, nextAtomic, existing.decimals),
        })
        continue
      }
      tokensByMint.set(mint, {
        id: `solana:mainnet:${mint}`,
        chain: 'solana',
        networkId: 'solana-mainnet',
        networkLabel: 'Solana',
        symbol,
        name,
        decimals,
        balanceAtomic: amountAtomic,
        ...display,
        isNative: false,
        tokenMint: mint,
        explorerUrl: `${SOLSCAN_TOKEN_BASE}${mint}`,
      })
    }
  }

  const unknownMints = [...tokensByMint.keys()].filter((mint) => !KNOWN_SOLANA_TOKENS[mint])
  const metadataByMint = await resolveSolanaMetadata(unknownMints)
  for (const [mint, metadata] of metadataByMint.entries()) {
    const existing = tokensByMint.get(mint)
    if (!existing) continue
    const symbol = metadata.symbol?.trim() || existing.symbol
    const name = metadata.name?.trim() || existing.name
    tokensByMint.set(mint, {
      ...existing,
      symbol,
      name,
      ...normalizeAssetDisplay(symbol, existing.balanceAtomic, existing.decimals),
    })
  }

  assets.push(...tokensByMint.values())
  const sortedAssets = sortAssets(assets)
  return {
    balanceAtomic: nativeBalanceAtomic,
    balanceFormatted: nativeDisplay.balanceFormatted,
    balanceDisplay: nativeDisplay.balanceDisplay,
    balanceSymbol: 'SOL',
    balanceLamports: Number.parseInt(nativeBalanceAtomic, 10),
    balanceSol: Number.parseFloat(nativeDisplay.balanceFormatted),
    assets: sortedAssets,
    summary: buildPortfolioSummary(sortedAssets),
  }
}

async function fetchAlchemyTokenContracts(provider: JsonRpcProvider, address: string): Promise<string[] | null> {
  try {
    const response = await provider.send('alchemy_getTokenBalances', [address, 'erc20']) as {
      tokenBalances?: Array<{ contractAddress?: string; tokenBalance?: string }>
    }
    const balances = Array.isArray(response?.tokenBalances) ? response.tokenBalances : []
    return balances
      .map((entry) => String(entry?.contractAddress || '').trim())
      .filter((value) => value && value !== '0x0000000000000000000000000000000000000000')
  } catch {
    return null
  }
}

async function readErc20Bytes32Metadata(
  provider: JsonRpcProvider,
  contractAddress: string,
  method: 'symbol' | 'name',
): Promise<string> {
  try {
    const iface = method === 'symbol' ? ERC20_SYMBOL_BYTES32_IFACE : ERC20_NAME_BYTES32_IFACE
    const raw = await provider.call({
      to: contractAddress,
      data: iface.encodeFunctionData(method, []),
    })
    if (!raw || raw === '0x') return ''
    const decoded = iface.decodeFunctionResult(method, raw)[0]
    if (typeof decoded !== 'string') return ''
    return readFixedUtf8String(Buffer.from(decoded.slice(2), 'hex'), 0, 32)
  } catch {
    return ''
  }
}

async function getLogsWithChunking(
  provider: JsonRpcProvider,
  filter: { fromBlock: number; toBlock: number; topics: Array<string | null> },
  maxLogRange?: number,
) {
  const ranges = buildLogDiscoveryRanges(filter.fromBlock, filter.toBlock, maxLogRange)
  const logs = []
  for (const range of ranges) {
    logs.push(...await provider.getLogs({
      ...filter,
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
    }))
  }
  return logs
}

async function discoverErc20ContractsFromLogs(
  provider: JsonRpcProvider,
  address: string,
  walletId: string,
  walletCreatedAt: number,
  network: EvmNetworkConfig,
): Promise<string[]> {
  const cacheKey = `${walletId}:${network.id}:${address.toLowerCase()}`
  const cached = evmContractDiscoveryCache.get(cacheKey)
  try {
    const latestBlock = await provider.getBlockNumber()
    const contractSet = new Set(cached?.contractAddresses || [])
    const fallbackFromBlock = estimateDiscoveryStartBlock({
      latestBlock,
      walletCreatedAt,
      avgBlockMs: network.avgBlockMs,
      maxDiscoveryBlocks: network.maxDiscoveryBlocks,
    })
    const fromBlock = cached && cached.walletCreatedAt === walletCreatedAt
      ? Math.max(fallbackFromBlock, cached.scannedToBlock + 1)
      : fallbackFromBlock
    if (fromBlock > latestBlock) return [...contractSet]

    const paddedAddress = zeroPadValue(getAddress(address), 32)
    const [incoming, outgoing] = await Promise.all([
      getLogsWithChunking(provider, {
        fromBlock,
        toBlock: latestBlock,
        topics: [ERC20_TRANSFER_TOPIC, null, paddedAddress],
      }, network.maxLogRange),
      getLogsWithChunking(provider, {
        fromBlock,
        toBlock: latestBlock,
        topics: [ERC20_TRANSFER_TOPIC, paddedAddress],
      }, network.maxLogRange),
    ])
    for (const contractAddress of [...incoming, ...outgoing]
      .map((log) => {
        try {
          return getAddress(log.address)
        } catch {
          return ''
        }
      })
      .filter(Boolean)) {
      contractSet.add(contractAddress)
    }
    evmContractDiscoveryCache.set(cacheKey, {
      expiresAt: Date.now() + EVM_CONTRACT_CACHE_TTL_MS,
      walletCreatedAt,
      scannedToBlock: latestBlock,
      contractAddresses: [...contractSet],
    })
    return [...contractSet]
  } catch {
    return cached?.contractAddresses || []
  }
}

async function resolveAlchemyMetadata(
  provider: JsonRpcProvider,
  contractAddress: string,
): Promise<{ symbol?: string; name?: string; decimals?: number } | null> {
  try {
    const metadata = await provider.send('alchemy_getTokenMetadata', [contractAddress]) as {
      symbol?: string
      name?: string
      decimals?: number
    }
    return metadata || null
  } catch {
    return null
  }
}

async function resolveErc20Asset(
  provider: JsonRpcProvider,
  address: string,
  contractAddress: string,
  network: EvmNetworkConfig,
): Promise<WalletAssetBalance | null> {
  try {
    const normalizedContractAddress = getAddress(contractAddress)
    const contract = new Contract(normalizedContractAddress, ERC20_ABI, provider)
    const metadata = await resolveAlchemyMetadata(provider, contractAddress)
    const knownToken = network.knownTokens?.find((token) => token.address.toLowerCase() === normalizedContractAddress.toLowerCase())
    const [balanceRaw, decimalsRaw, symbolRaw, nameRaw] = await Promise.all([
      contract.balanceOf(address).catch(() => BigInt(0)),
      metadata?.decimals != null
        ? Promise.resolve(metadata.decimals)
        : knownToken?.decimals != null
          ? Promise.resolve(knownToken.decimals)
          : contract.decimals().catch(() => 18),
      metadata?.symbol
        ? Promise.resolve(metadata.symbol)
        : knownToken?.symbol
          ? Promise.resolve(knownToken.symbol)
          : contract.symbol().catch(() => readErc20Bytes32Metadata(provider, normalizedContractAddress, 'symbol')),
      metadata?.name
        ? Promise.resolve(metadata.name)
        : knownToken?.name
          ? Promise.resolve(knownToken.name)
          : contract.name().catch(() => readErc20Bytes32Metadata(provider, normalizedContractAddress, 'name')),
    ])
    const balanceAtomic = balanceRaw.toString()
    if (BigInt(balanceAtomic) <= BigInt(0)) return null
    const decimals = typeof decimalsRaw === 'number' ? decimalsRaw : Number(decimalsRaw ?? 18)
    const symbol = typeof symbolRaw === 'string' && symbolRaw.trim() ? symbolRaw.trim() : shortId(normalizedContractAddress)
    const name = typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : `ERC-20 ${shortId(normalizedContractAddress)}`
    const display = normalizeAssetDisplay(symbol, balanceAtomic, decimals)
    return {
      id: `${network.id}:${normalizedContractAddress.toLowerCase()}`,
      chain: 'ethereum',
      networkId: network.id,
      networkLabel: network.label,
      symbol,
      name,
      decimals,
      balanceAtomic,
      ...display,
      isNative: false,
      contractAddress: normalizedContractAddress,
      explorerUrl: `${network.tokenExplorerBaseUrl}${normalizedContractAddress}`,
    }
  } catch {
    return null
  }
}

async function fetchEvmAssets(wallet: AgentWallet): Promise<WalletPortfolio> {
  const assets: WalletAssetBalance[] = []
  let totalNativeAtomic = BigInt(0)

  for (const network of getEnabledEvmNetworks()) {
    const provider = getEthereumProvider(network.rpcUrl)
    let nativeBalanceAtomic = '0'
    try {
      nativeBalanceAtomic = (await provider.getBalance(wallet.publicKey)).toString()
    } catch {
      nativeBalanceAtomic = '0'
    }
    totalNativeAtomic += BigInt(nativeBalanceAtomic)
    assets.push({
      id: `${network.id}:native`,
      chain: 'ethereum',
      networkId: network.id,
      networkLabel: network.label,
      symbol: 'ETH',
      name: `${network.label} ETH`,
      decimals: 18,
      balanceAtomic: nativeBalanceAtomic,
      ...normalizeAssetDisplay('ETH', nativeBalanceAtomic, 18, { minFractionDigits: 4 }),
      isNative: true,
      explorerUrl: `${network.addressExplorerBaseUrl}${wallet.publicKey}`,
    })

    const contractSet = new Set<string>()
    for (const knownToken of network.knownTokens || []) contractSet.add(knownToken.address)
    const alchemyContracts = await fetchAlchemyTokenContracts(provider, wallet.publicKey)
    for (const contractAddress of alchemyContracts || []) contractSet.add(getAddress(contractAddress))
    const discoveredContracts = await discoverErc20ContractsFromLogs(provider, wallet.publicKey, wallet.id, wallet.createdAt, network)
    for (const contractAddress of discoveredContracts) contractSet.add(contractAddress)

    const tokenAssets = await Promise.all(
      [...contractSet].map((contractAddress) => resolveErc20Asset(provider, wallet.publicKey, contractAddress, network)),
    )
    assets.push(...tokenAssets.filter((asset): asset is WalletAssetBalance => Boolean(asset)))
  }

  const nativeBalanceAtomic = totalNativeAtomic.toString()
  const nativeDisplay = normalizeAssetDisplay('ETH', nativeBalanceAtomic, 18, { minFractionDigits: 4 })
  const sortedAssets = sortAssets(assets)
  return {
    balanceAtomic: nativeBalanceAtomic,
    balanceFormatted: nativeDisplay.balanceFormatted,
    balanceDisplay: nativeDisplay.balanceDisplay,
    balanceSymbol: getWalletAssetSymbol('ethereum'),
    assets: sortedAssets,
    summary: buildPortfolioSummary(sortedAssets),
  }
}

export async function getWalletPortfolio(wallet: AgentWallet, options?: GetWalletPortfolioOptions): Promise<WalletPortfolio> {
  const cacheKey = buildPortfolioCacheKey(wallet)
  const cached = getCurrentCachedPortfolioEntry(wallet)
  if (cached && cached.expiresAt > Date.now()) return cached.portfolio

  const stale = options?.allowStale ? getLatestCachedPortfolioEntry(wallet.id)?.portfolio || null : null
  const portfolio = await resolveWalletPortfolioWithTimeout({
    load: () => (wallet.chain === 'ethereum' ? fetchEvmAssets(wallet) : fetchSolanaAssets(wallet)),
    timeoutMs: options?.timeoutMs,
    stale,
    label: `wallet portfolio ${wallet.id}`,
  })

  portfolioCache.set(cacheKey, {
    expiresAt: Date.now() + PORTFOLIO_CACHE_TTL_MS,
    portfolio,
  })
  return portfolio
}

export function clearWalletPortfolioCache(walletId?: string) {
  if (!walletId) {
    portfolioCache.clear()
    evmContractDiscoveryCache.clear()
    return
  }
  for (const key of portfolioCache.keys()) {
    if (key.startsWith(`${walletId}:`)) portfolioCache.delete(key)
  }
  for (const [key, entry] of evmContractDiscoveryCache.entries()) {
    if (entry.expiresAt <= Date.now() || key.startsWith(`${walletId}:`)) evmContractDiscoveryCache.delete(key)
  }
}
