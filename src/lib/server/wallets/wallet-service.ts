import { genId } from '@/lib/id'
import { loadWallets, loadWallet, saveWallet, deleteWallet } from './wallet-repository'
import { generateEthereumWallet, normalizeEthereumAddress } from './wallet-crypto'
import { logActivity } from '@/lib/server/activity/activity-log'
import { loadAgent } from '@/lib/server/agents/agent-repository'
import type { AgentWallet, SafeWallet } from '@/types/swarmdock'

export class WalletServiceError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'WalletServiceError'
    this.status = status
  }
}

function stripPrivateKey(wallet: AgentWallet): SafeWallet {
  const { encryptedPrivateKey: _, ...safe } = wallet
  return safe
}

function requireAgent(agentId: string): string {
  const normalizedAgentId = agentId.trim()
  if (!normalizedAgentId) {
    throw new WalletServiceError(400, 'agentId is required')
  }
  if (!loadAgent(normalizedAgentId)) {
    throw new WalletServiceError(404, `Agent not found: ${normalizedAgentId}`)
  }
  return normalizedAgentId
}

async function requireWalletAddress(walletAddress: string): Promise<string> {
  const normalizedAddress = walletAddress.trim()
  if (!normalizedAddress) {
    throw new WalletServiceError(400, 'walletAddress is required')
  }
  const checksumAddress = await normalizeEthereumAddress(normalizedAddress)
  if (!checksumAddress) {
    throw new WalletServiceError(400, 'walletAddress must be a valid Base/Ethereum address')
  }
  return checksumAddress
}

export function listWalletsSafe(): Record<string, SafeWallet> {
  const wallets = loadWallets()
  const safe: Record<string, SafeWallet> = {}
  for (const [id, w] of Object.entries(wallets)) {
    safe[id] = stripPrivateKey(w)
  }
  return safe
}

export function getWalletSafe(id: string): SafeWallet | null {
  const wallet = loadWallet(id)
  return wallet ? stripPrivateKey(wallet) : null
}

/** Generate a new Base L2 Ethereum wallet with encrypted private key storage. */
export async function generateWallet(params: { agentId: string; label?: string }): Promise<SafeWallet> {
  const agentId = requireAgent(params.agentId)
  const { address, encryptedPrivateKey } = await generateEthereumWallet()
  const id = genId()
  const wallet: AgentWallet = {
    id,
    agentId,
    walletAddress: address,
    chain: 'base',
    label: params.label || 'Base L2 Wallet',
    encryptedPrivateKey,
    requireApproval: true,
    createdAt: Date.now(),
  }
  saveWallet(id, wallet)
  logActivity({ entityType: 'wallet', entityId: id, action: 'created', actor: 'user', summary: `Wallet generated: ${address}` })
  return stripPrivateKey(wallet)
}

/** Create a wallet from an existing address (no key generation). */
export async function createWallet(params: { agentId: string; walletAddress: string; label?: string }): Promise<SafeWallet> {
  const agentId = requireAgent(params.agentId)
  const walletAddress = await requireWalletAddress(params.walletAddress)
  const id = genId()
  const wallet: AgentWallet = {
    id,
    agentId,
    walletAddress,
    chain: 'base',
    label: params.label,
    createdAt: Date.now(),
  }
  saveWallet(id, wallet)
  logActivity({ entityType: 'wallet', entityId: id, action: 'created', actor: 'user', summary: `Wallet created: ${walletAddress}` })
  return stripPrivateKey(wallet)
}

/** Update wallet settings (label, limits, approval). */
export function updateWallet(
  id: string,
  patch: Partial<Pick<AgentWallet, 'label' | 'spendingLimitUsdc' | 'dailyLimitUsdc' | 'requireApproval'>>,
): SafeWallet | null {
  const wallet = loadWallet(id)
  if (!wallet) return null
  if (patch.label !== undefined) wallet.label = patch.label
  if (patch.spendingLimitUsdc !== undefined) wallet.spendingLimitUsdc = patch.spendingLimitUsdc
  if (patch.dailyLimitUsdc !== undefined) wallet.dailyLimitUsdc = patch.dailyLimitUsdc
  if (patch.requireApproval !== undefined) wallet.requireApproval = patch.requireApproval
  saveWallet(id, wallet)
  return stripPrivateKey(wallet)
}

export function removeWallet(id: string): boolean {
  const wallet = loadWallet(id)
  if (!wallet) return false
  deleteWallet(id)
  logActivity({ entityType: 'wallet', entityId: id, action: 'deleted', actor: 'user', summary: `Wallet deleted: ${wallet.walletAddress}` })
  return true
}
