import { genId } from '@/lib/id'
import {
  formatWalletAmount,
  getWalletAssetSymbol,
  getWalletAtomicAmount,
  getWalletChainOrDefault,
  getWalletDefaultLimitAtomic,
  getWalletLimitAtomic,
  normalizeAtomicString,
} from '@/lib/wallet'
import type { Agent, AgentWallet, WalletChain, WalletTransaction } from '@/types'
import { loadAgent, loadAgents, loadWalletTransactions, loadWallets, upsertAgent, upsertWallet } from './storage'
import { generateEthereumWallet, isValidEthereumAddress, sendEth } from './ethereum'
import { generateSolanaKeypair, isValidSolanaAddress, sendSol } from './solana'
import { notify } from './ws-hub'
import { clearWalletPortfolioCache, getWalletPortfolio, type GetWalletPortfolioOptions, type WalletPortfolio } from './wallet-portfolio'

function generateWalletCredentials(chain: WalletChain): { publicKey: string; encryptedPrivateKey: string } {
  if (chain === 'ethereum') return generateEthereumWallet()
  return generateSolanaKeypair()
}

export function stripWalletPrivateKey<T extends Record<string, unknown>>(wallet: T): Omit<T, 'encryptedPrivateKey'> {
  return Object.fromEntries(Object.entries(wallet).filter(([key]) => key !== 'encryptedPrivateKey')) as Omit<T, 'encryptedPrivateKey'>
}

export function getAgentWalletIds(agent: Pick<Agent, 'walletIds' | 'walletId'> | null | undefined): string[] {
  const ids = Array.isArray(agent?.walletIds)
    ? agent.walletIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
  const legacy = typeof agent?.walletId === 'string' && agent.walletId.trim()
    ? [agent.walletId.trim()]
    : []
  return [...new Set([...ids, ...legacy])]
}

export function getAgentActiveWalletId(
  agent: Pick<Agent, 'walletIds' | 'walletId' | 'activeWalletId'> | null | undefined,
  walletIds = getAgentWalletIds(agent),
): string | null {
  if (typeof agent?.activeWalletId === 'string' && walletIds.includes(agent.activeWalletId)) return agent.activeWalletId
  if (typeof agent?.walletId === 'string' && walletIds.includes(agent.walletId)) return agent.walletId
  return walletIds[0] || null
}

function syncAgentWalletPointers(agent: Agent, walletIds: string[], activeWalletId?: string | null): Agent {
  const normalizedIds = [...new Set(walletIds.filter(Boolean))]
  const normalizedActive = activeWalletId && normalizedIds.includes(activeWalletId)
    ? activeWalletId
    : normalizedIds[0] || null
  agent.walletIds = normalizedIds
  agent.activeWalletId = normalizedActive
  agent.walletId = normalizedActive
  return agent
}

export function linkWalletToAgent(agent: Agent, walletId: string, makeActive = false): Agent {
  const walletIds = getAgentWalletIds(agent)
  if (!walletIds.includes(walletId)) walletIds.push(walletId)
  const activeWalletId = makeActive ? walletId : getAgentActiveWalletId(agent, walletIds)
  return syncAgentWalletPointers(agent, walletIds, activeWalletId)
}

export function unlinkWalletFromAgent(agent: Agent, walletId: string): Agent {
  const walletIds = getAgentWalletIds(agent).filter((id) => id !== walletId)
  const activeWalletId = getAgentActiveWalletId(agent, walletIds)
  return syncAgentWalletPointers(agent, walletIds, activeWalletId)
}

export function setAgentActiveWallet(agent: Agent, walletId: string | null): Agent {
  const walletIds = getAgentWalletIds(agent)
  const activeWalletId = walletId && walletIds.includes(walletId) ? walletId : walletIds[0] || null
  return syncAgentWalletPointers(agent, walletIds, activeWalletId)
}

export function getWalletsByAgentId(agentId: string): AgentWallet[] {
  const wallets = loadWallets() as Record<string, AgentWallet>
  return Object.values(wallets)
    .filter((wallet) => wallet.agentId === agentId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function getWalletByAgentId(agentId: string, chain?: WalletChain | null): AgentWallet | null {
  const wallets = getWalletsByAgentId(agentId)
  if (chain) return wallets.find((wallet) => wallet.chain === chain) ?? null

  const agents = loadAgents()
  const agent = agents[agentId]
  const activeWalletId = getAgentActiveWalletId(agent)
  return wallets.find((wallet) => wallet.id === activeWalletId) ?? wallets[0] ?? null
}

export function createAgentWallet(input: {
  agentId: string
  chain?: WalletChain | string | null
  provider?: WalletChain | string | null
  label?: string
  requireApproval?: boolean
  spendingLimitAtomic?: string | number | null
  dailyLimitAtomic?: string | number | null
}): AgentWallet {
  const agentId = String(input.agentId || '').trim()
  if (!agentId) throw new Error('agentId is required')

  const agent = loadAgent(agentId)
  if (!agent) throw new Error('Agent not found')

  const chain = getWalletChainOrDefault(input.chain ?? input.provider, 'solana')
  const existing = getWalletByAgentId(agentId, chain)
  if (existing) throw new Error(`Agent already has a ${chain} wallet`)
  const { publicKey, encryptedPrivateKey } = generateWalletCredentials(chain)
  const id = genId()
  const now = Date.now()
  const wallet: AgentWallet = {
    id,
    agentId,
    chain,
    publicKey,
    encryptedPrivateKey,
    label: typeof input.label === 'string' && input.label.trim() ? input.label.trim() : undefined,
    spendingLimitAtomic: normalizeAtomicString(input.spendingLimitAtomic, getWalletDefaultLimitAtomic(chain, 'perTx')),
    dailyLimitAtomic: normalizeAtomicString(input.dailyLimitAtomic, getWalletDefaultLimitAtomic(chain, 'daily')),
    requireApproval: input.requireApproval !== false,
    createdAt: now,
    updatedAt: now,
  }

  upsertWallet(id, wallet)
  clearWalletPortfolioCache(id)

  linkWalletToAgent(agent as any, id, getAgentActiveWalletId(agent as any) == null)
  agent.updatedAt = now
  upsertAgent(agentId, agent)

  notify('wallets')
  notify('agents')

  return wallet
}

export async function getWalletBalanceAtomic(wallet: AgentWallet): Promise<string> {
  return (await getWalletPortfolio(wallet)).balanceAtomic
}

export async function getWalletPortfolioSnapshot(
  wallet: AgentWallet,
  options?: GetWalletPortfolioOptions,
): Promise<WalletPortfolio> {
  return getWalletPortfolio(wallet, options)
}

export function validateWalletSendLimits(params: {
  wallet: AgentWallet
  amountAtomic: string
  transactions?: WalletTransaction[]
  now?: number
  excludeTransactionId?: string
}): string | null {
  const { wallet } = params
  const amountAtomic = normalizeAtomicString(params.amountAtomic, '0')
  const assetSymbol = getWalletAssetSymbol(wallet.chain)

  if (BigInt(amountAtomic) <= BigInt(0)) {
    return 'Amount must be positive'
  }

  const perTxLimitAtomic = getWalletLimitAtomic(wallet, 'perTx')
  if (BigInt(amountAtomic) > BigInt(perTxLimitAtomic)) {
    return `Amount ${formatWalletAmount(wallet.chain, amountAtomic, { maxFractionDigits: 6 })} ${assetSymbol} exceeds per-transaction limit of ${formatWalletAmount(wallet.chain, perTxLimitAtomic, { maxFractionDigits: 6 })} ${assetSymbol}`
  }

  const dailyLimitAtomic = getWalletLimitAtomic(wallet, 'daily')
  const oneDayAgo = (params.now ?? Date.now()) - 24 * 60 * 60 * 1000
  const transactions = params.transactions
    ?? Object.values(loadWalletTransactions() as Record<string, WalletTransaction>)
  const dailySpentAtomic = transactions
    .filter((tx) => tx.walletId === wallet.id)
    .filter((tx) => tx.id !== params.excludeTransactionId)
    .filter((tx) => tx.type === 'send' && tx.status === 'confirmed' && tx.timestamp > oneDayAgo)
    .reduce((sum, tx) => sum + BigInt(getWalletAtomicAmount(tx)), BigInt(0))

  if (dailySpentAtomic + BigInt(amountAtomic) > BigInt(dailyLimitAtomic)) {
    return `Daily limit exceeded. Spent ${formatWalletAmount(wallet.chain, dailySpentAtomic.toString(), { maxFractionDigits: 6 })} ${assetSymbol} in the last 24h, limit is ${formatWalletAmount(wallet.chain, dailyLimitAtomic, { maxFractionDigits: 6 })} ${assetSymbol}`
  }

  return null
}

export function isValidWalletAddress(chain: WalletChain, address: string): boolean {
  if (chain === 'ethereum') return isValidEthereumAddress(address)
  return isValidSolanaAddress(address)
}

export async function sendWalletNativeAsset(
  wallet: AgentWallet,
  toAddress: string,
  amountAtomic: string,
): Promise<{ signature: string; feeAtomic?: string }> {
  if (wallet.chain === 'ethereum') {
    const result = await sendEth(wallet.encryptedPrivateKey, toAddress, amountAtomic)
    clearWalletPortfolioCache(wallet.id)
    return { signature: result.signature, feeAtomic: result.fee }
  }

  const result = await sendSol(wallet.encryptedPrivateKey, toAddress, Number.parseInt(amountAtomic, 10))
  clearWalletPortfolioCache(wallet.id)
  return {
    signature: result.signature,
    feeAtomic: String(result.fee),
  }
}
