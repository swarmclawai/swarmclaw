import { Contract, JsonRpcProvider, getAddress, isAddress } from 'ethers'

import { formatAtomicAmount, normalizeAtomicString, parseDisplayAmountToAtomic } from '@/lib/wallet/wallet'
import type { AgentWallet, WalletAssetBalance } from '@/types'

import { getEvmNetworkConfig, getProviderForNetwork, type EvmNetworkId } from './ethereum'
import { getWalletPortfolioSnapshot } from '@/lib/server/wallet/wallet-service'
import { errorMessage } from '@/lib/shared-utils'

const PARASWAP_API_BASE = 'https://api.paraswap.io'
const PARASWAP_VERSION = '6.2'
const PARASWAP_NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const ERC20_ALLOWANCE_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
] as const
const TOKEN_LIST_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 15_000

interface CachedTokenList {
  expiresAt: number
  assets: ResolvedEvmSwapAsset[]
}

const paraswapTokenListCache = new Map<EvmNetworkId, CachedTokenList>()

export interface ResolvedEvmSwapAsset {
  address: string
  symbol: string
  name: string
  decimals: number
  isNative: boolean
  source: 'native' | 'portfolio' | 'paraswap' | 'onchain'
}

export interface PreparedEvmSwapPlan {
  provider: 'paraswap'
  network: ReturnType<typeof getEvmNetworkConfig>
  walletAddress: string
  recipient: string
  sellToken: ResolvedEvmSwapAsset
  buyToken: ResolvedEvmSwapAsset
  sellAmountAtomic: string
  sellAmountDisplay: string
  buyAmountAtomic: string
  buyAmountDisplay: string
  slippageBps: number
  spenderAddress: string | null
  approvalRequired: boolean
  approvalTransaction: Record<string, unknown> | null
  swapTransaction: Record<string, unknown>
  routeSummary: string
  priceRoute: Record<string, unknown>
}

export interface PrepareEvmSwapPlanInput {
  wallet: AgentWallet
  network: EvmNetworkId | string
  sellToken: unknown
  buyToken: unknown
  sellAmountAtomic?: unknown
  sellAmountDisplay?: unknown
  slippageBps?: unknown
  recipient?: unknown
  rpcUrl?: string | null
  skipBalanceCheck?: boolean
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function looksLikeEvmAddress(value: string): boolean {
  return isAddress(value)
}

function normalizeLowerAddress(value: string): string {
  return getAddress(value).toLowerCase()
}

function makeNativeEthAsset(): ResolvedEvmSwapAsset {
  return {
    address: PARASWAP_NATIVE_TOKEN,
    symbol: 'ETH',
    name: 'Ether',
    decimals: 18,
    isNative: true,
    source: 'native',
  }
}

function normalizeSlippageBps(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 0 && value <= 10) return Math.round(value * 100)
    return Math.max(1, Math.min(5_000, Math.trunc(value)))
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return 100
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const parsed = Number.parseFloat(trimmed)
      if (parsed > 0 && parsed <= 10) return Math.round(parsed * 100)
      return Math.max(1, Math.min(5_000, Math.trunc(parsed)))
    }
  }
  return 100
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init?.headers || {}),
      },
    })
    const text = await response.text()
    const payload = text ? JSON.parse(text) as unknown : null
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && payload && 'error' in payload
        ? String((payload as { error?: unknown }).error)
        : `${response.status} ${response.statusText}`.trim()
      throw new Error(`ParaSwap API request failed: ${message}`)
    }
    return payload
  } finally {
    clearTimeout(timer)
  }
}

async function getParaswapTokenList(network: EvmNetworkId): Promise<ResolvedEvmSwapAsset[]> {
  const cached = paraswapTokenListCache.get(network)
  if (cached && cached.expiresAt > Date.now()) return cached.assets

  const config = getEvmNetworkConfig(network)
  const response = await fetchJson(`${PARASWAP_API_BASE}/tokens/${config.chainId}`) as {
    tokens?: Array<{
      address?: string
      symbol?: string
      name?: string
      decimals?: number
    }>
  }
  const assets = (Array.isArray(response?.tokens) ? response.tokens : [])
    .flatMap((token) => {
      const address = normalizeText(token?.address)
      const symbol = normalizeText(token?.symbol)
      if (!address || !symbol) return []
      if (address.toLowerCase() === PARASWAP_NATIVE_TOKEN.toLowerCase()) return [makeNativeEthAsset()]
      if (!looksLikeEvmAddress(address)) return []
      return [{
        address: getAddress(address),
        symbol,
        name: normalizeText(token?.name) || symbol,
        decimals: typeof token?.decimals === 'number' ? token.decimals : 18,
        isNative: false,
        source: 'paraswap' as const,
      }]
    })

  const deduped = Array.from(new Map(
    assets.map((asset) => [asset.address.toLowerCase(), asset]),
  ).values())
  paraswapTokenListCache.set(network, {
    expiresAt: Date.now() + TOKEN_LIST_TTL_MS,
    assets: deduped,
  })
  return deduped
}

function getPortfolioAssetCandidates(
  walletAssets: WalletAssetBalance[],
  networkId: EvmNetworkId,
  tokenRef: string,
): ResolvedEvmSwapAsset[] {
  const normalized = tokenRef.trim().toLowerCase()
  return walletAssets
    .filter((asset) => asset.chain === 'ethereum' && asset.networkId === networkId)
    .flatMap((asset) => {
      const address = asset.isNative ? PARASWAP_NATIVE_TOKEN : normalizeText(asset.contractAddress)
      if (!address) return []
      const symbol = normalizeText(asset.symbol)
      const name = normalizeText(asset.name)
      const matchesAddress = !asset.isNative && looksLikeEvmAddress(tokenRef) && address.toLowerCase() === normalized
      const matchesSymbol = symbol.toLowerCase() === normalized
      const matchesName = name.toLowerCase() === normalized
      const matchesNative = asset.isNative && ['eth', 'native', PARASWAP_NATIVE_TOKEN.toLowerCase()].includes(normalized)
      if (!matchesAddress && !matchesSymbol && !matchesName && !matchesNative) return []
      return [{
        address: asset.isNative ? PARASWAP_NATIVE_TOKEN : getAddress(address),
        symbol: symbol || (asset.isNative ? 'ETH' : 'TOKEN'),
        name: name || symbol || 'Token',
        decimals: typeof asset.decimals === 'number' ? asset.decimals : (asset.isNative ? 18 : 18),
        isNative: asset.isNative === true,
        source: 'portfolio' as const,
      }]
    })
}

async function resolveTokenByAddress(
  provider: JsonRpcProvider,
  address: string,
): Promise<ResolvedEvmSwapAsset> {
  const normalizedAddress = getAddress(address)
  const contract = new Contract(normalizedAddress, ERC20_ALLOWANCE_ABI, provider)
  const [decimalsRaw, symbolRaw, nameRaw] = await Promise.all([
    contract.decimals().catch(() => 18),
    contract.symbol().catch(() => 'TOKEN'),
    contract.name().catch(() => 'Token'),
  ])
  return {
    address: normalizedAddress,
    symbol: normalizeText(symbolRaw) || 'TOKEN',
    name: normalizeText(nameRaw) || normalizeText(symbolRaw) || 'Token',
    decimals: typeof decimalsRaw === 'number' ? decimalsRaw : Number(decimalsRaw ?? 18),
    isNative: false,
    source: 'onchain',
  }
}

export async function resolveEvmSwapAsset(input: {
  wallet: AgentWallet
  network: EvmNetworkId | string
  token: unknown
  rpcUrl?: string | null
}): Promise<ResolvedEvmSwapAsset> {
  const tokenRef = normalizeText(input.token)
  if (!tokenRef) throw new Error('Token is required')

  const network = getEvmNetworkConfig(input.network).id
  const normalized = tokenRef.toLowerCase()
  if (['eth', 'native', PARASWAP_NATIVE_TOKEN.toLowerCase()].includes(normalized)) {
    return makeNativeEthAsset()
  }

  const portfolio = await getWalletPortfolioSnapshot(input.wallet)
  const portfolioMatches = getPortfolioAssetCandidates(portfolio.assets, network, tokenRef)
  if (portfolioMatches.length === 1) return portfolioMatches[0]

  const tokenList = await getParaswapTokenList(network)
  if (looksLikeEvmAddress(tokenRef)) {
    const addressMatch = tokenList.find((asset) => asset.address.toLowerCase() === normalized.toLowerCase())
    if (addressMatch) return addressMatch
    return resolveTokenByAddress(getProviderForNetwork(network, input.rpcUrl), tokenRef)
  }

  const symbolMatches = tokenList.filter((asset) => asset.symbol.toLowerCase() === normalized)
  if (symbolMatches.length === 1) return symbolMatches[0]
  if (portfolioMatches.length > 1) {
    throw new Error(`Token "${tokenRef}" matches multiple wallet assets on ${network}. Use the contract address instead.`)
  }
  if (symbolMatches.length > 1) {
    throw new Error(`Token "${tokenRef}" matches multiple ParaSwap assets on ${network}. Use the token contract address instead.`)
  }

  const nameMatch = tokenList.find((asset) => asset.name.toLowerCase() === normalized)
  if (nameMatch) return nameMatch

  throw new Error(`Could not resolve token "${tokenRef}" on ${network}. Use a symbol like USDC/ETH or a token contract address.`)
}

function parseSellAmountAtomic(input: {
  sellAmountAtomic?: unknown
  sellAmountDisplay?: unknown
  decimals: number
}): string {
  const atomic = normalizeAtomicString(input.sellAmountAtomic, '')
  if (atomic) {
    if (BigInt(atomic) <= BigInt(0)) throw new Error('Swap amount must be positive')
    return atomic
  }
  const displayRaw = input.sellAmountDisplay
  if (
    displayRaw === undefined
    || displayRaw === null
    || (typeof displayRaw === 'string' && displayRaw.trim() === '')
  ) {
    throw new Error('sellAmountAtomic or sellAmountDisplay is required for swap')
  }
  const display = typeof displayRaw === 'number' || typeof displayRaw === 'string'
    ? displayRaw
    : String(displayRaw)
  const parsed = parseDisplayAmountToAtomic(display, input.decimals)
  if (BigInt(parsed) <= BigInt(0)) throw new Error('Swap amount must be positive')
  return parsed
}

async function getTokenBalanceAtomic(
  provider: JsonRpcProvider,
  walletAddress: string,
  token: ResolvedEvmSwapAsset,
): Promise<bigint> {
  if (token.isNative) {
    return provider.getBalance(walletAddress)
  }
  const contract = new Contract(token.address, ERC20_ALLOWANCE_ABI, provider)
  const balance = await contract.balanceOf(walletAddress)
  return BigInt(balance.toString())
}

async function getTokenAllowanceAtomic(
  provider: JsonRpcProvider,
  walletAddress: string,
  spenderAddress: string,
  token: ResolvedEvmSwapAsset,
): Promise<bigint> {
  if (token.isNative) return BigInt(0)
  const contract = new Contract(token.address, ERC20_ALLOWANCE_ABI, provider)
  const allowance = await contract.allowance(walletAddress, spenderAddress)
  return BigInt(allowance.toString())
}

function collectRouteExchanges(priceRoute: Record<string, unknown>): string[] {
  const bestRoute = Array.isArray(priceRoute.bestRoute) ? priceRoute.bestRoute : []
  const exchanges = new Set<string>()
  for (const route of bestRoute) {
    const swaps = Array.isArray((route as { swaps?: unknown[] }).swaps) ? (route as { swaps: unknown[] }).swaps : []
    for (const swap of swaps) {
      const swapExchanges = Array.isArray((swap as { swapExchanges?: unknown[] }).swapExchanges)
        ? (swap as { swapExchanges: unknown[] }).swapExchanges
        : []
      for (const entry of swapExchanges) {
        const exchange = normalizeText((entry as { exchange?: unknown }).exchange)
        if (exchange) exchanges.add(exchange)
      }
    }
  }
  return [...exchanges]
}

function toComparableTransaction(transaction: Record<string, unknown>, network: ReturnType<typeof getEvmNetworkConfig>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  const to = normalizeText(transaction.to)
  const data = normalizeText(transaction.data)
  const value = transaction.value
  if (to) normalized.to = getAddress(to)
  if (data) normalized.data = data
  if (value !== undefined && value !== null && String(value).trim() !== '') normalized.value = String(value).trim()
  normalized.chainId = network.chainId
  return normalized
}

export async function prepareEvmSwapPlan(input: PrepareEvmSwapPlanInput): Promise<PreparedEvmSwapPlan> {
  if (input.wallet.chain !== 'ethereum') {
    throw new Error('Generic swap is currently supported only for Ethereum-compatible wallets')
  }

  const network = getEvmNetworkConfig(input.network)
  const provider = getProviderForNetwork(network.id, input.rpcUrl || undefined)
  const walletAddress = getAddress(input.wallet.publicKey)
  const recipient = normalizeText(input.recipient) ? getAddress(normalizeText(input.recipient)) : walletAddress
  const sellToken = await resolveEvmSwapAsset({
    wallet: input.wallet,
    network: network.id,
    token: input.sellToken,
    rpcUrl: input.rpcUrl,
  })
  const buyToken = await resolveEvmSwapAsset({
    wallet: input.wallet,
    network: network.id,
    token: input.buyToken,
    rpcUrl: input.rpcUrl,
  })
  if (sellToken.address.toLowerCase() === buyToken.address.toLowerCase()) {
    throw new Error('Swap sellToken and buyToken must be different')
  }

  const sellAmountAtomic = parseSellAmountAtomic({
    sellAmountAtomic: input.sellAmountAtomic,
    sellAmountDisplay: input.sellAmountDisplay,
    decimals: sellToken.decimals,
  })
  if (input.skipBalanceCheck !== true) {
    const sellBalanceAtomic = await getTokenBalanceAtomic(provider, walletAddress, sellToken)
    if (sellBalanceAtomic < BigInt(sellAmountAtomic)) {
      const available = formatAtomicAmount(sellBalanceAtomic.toString(), sellToken.decimals, { maxFractionDigits: 6 })
      throw new Error(`Insufficient ${sellToken.symbol} balance on ${network.label}. Available ${available} ${sellToken.symbol}.`)
    }
  }

  const priceUrl = new URL(`${PARASWAP_API_BASE}/prices`)
  priceUrl.searchParams.set('srcToken', sellToken.address)
  priceUrl.searchParams.set('destToken', buyToken.address)
  priceUrl.searchParams.set('amount', sellAmountAtomic)
  priceUrl.searchParams.set('srcDecimals', String(sellToken.decimals))
  priceUrl.searchParams.set('destDecimals', String(buyToken.decimals))
  priceUrl.searchParams.set('side', 'SELL')
  priceUrl.searchParams.set('network', String(network.chainId))
  priceUrl.searchParams.set('version', PARASWAP_VERSION)
  const priceResponse = await fetchJson(priceUrl.toString()) as { priceRoute?: Record<string, unknown> }
  const priceRoute = priceResponse?.priceRoute
  if (!priceRoute || typeof priceRoute !== 'object') {
    throw new Error('ParaSwap did not return a price route')
  }

  const transactionsUrl = `${PARASWAP_API_BASE}/transactions/${network.chainId}?ignoreChecks=true`
  const transactionsRequest = {
    srcToken: sellToken.address,
    destToken: buyToken.address,
    srcAmount: sellAmountAtomic,
    userAddress: walletAddress,
    srcDecimals: sellToken.decimals,
    destDecimals: buyToken.decimals,
    priceRoute,
    receiver: recipient,
    slippage: normalizeSlippageBps(input.slippageBps),
  }
  const swapResponse = await fetchJson(transactionsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(transactionsRequest),
  }) as Record<string, unknown>

  const rawTo = normalizeText(swapResponse.to)
  const rawData = normalizeText(swapResponse.data)
  if (!rawTo || !rawData) {
    throw new Error('ParaSwap did not return executable transaction calldata')
  }

  const spenderAddress = normalizeText((priceRoute as { tokenTransferProxy?: unknown }).tokenTransferProxy)
    || normalizeText((priceRoute as { contractAddress?: unknown }).contractAddress)
    || rawTo

  let approvalRequired = false
  let approvalTransaction: Record<string, unknown> | null = null
  if (!sellToken.isNative) {
    const allowance = await getTokenAllowanceAtomic(provider, walletAddress, getAddress(spenderAddress), sellToken)
    approvalRequired = allowance < BigInt(sellAmountAtomic)
    if (approvalRequired) {
      approvalTransaction = {
        to: getAddress(sellToken.address),
        data: new Contract(sellToken.address, ERC20_ALLOWANCE_ABI, provider).interface.encodeFunctionData('approve', [
          getAddress(spenderAddress),
          BigInt(sellAmountAtomic),
        ]),
        value: '0',
        chainId: network.chainId,
      }
    }
  }

  const buyAmountAtomic = normalizeAtomicString((priceRoute as { destAmount?: unknown }).destAmount, '0')
  const exchanges = collectRouteExchanges(priceRoute)
  return {
    provider: 'paraswap',
    network,
    walletAddress,
    recipient,
    sellToken,
    buyToken,
    sellAmountAtomic,
    sellAmountDisplay: `${formatAtomicAmount(sellAmountAtomic, sellToken.decimals, { maxFractionDigits: 6 })} ${sellToken.symbol}`,
    buyAmountAtomic,
    buyAmountDisplay: `${formatAtomicAmount(buyAmountAtomic, buyToken.decimals, { maxFractionDigits: 6 })} ${buyToken.symbol}`,
    slippageBps: normalizeSlippageBps(input.slippageBps),
    spenderAddress: spenderAddress ? getAddress(spenderAddress) : null,
    approvalRequired,
    approvalTransaction,
    swapTransaction: toComparableTransaction(swapResponse, network),
    routeSummary: exchanges.length > 0 ? exchanges.join(', ') : 'ParaSwap route',
    priceRoute,
  }
}

export function isLikelyRetryableSwapError(err: unknown): boolean {
  const message = errorMessage(err)
  return /rate|price|slippage|expired|call exception|execution reverted|insufficient output/i.test(message)
}
