// --- SwarmDock Marketplace Types ---

export interface AgentWallet {
  id: string
  agentId: string
  walletAddress: string
  chain: 'base'
  label?: string
  encryptedPrivateKey?: string | null
  spendingLimitUsdc?: string | null
  dailyLimitUsdc?: string | null
  requireApproval?: boolean
  swarmdockAgentId?: string | null
  swarmdockDid?: string | null
  createdAt: number
}

export type SafeWallet = Omit<AgentWallet, 'encryptedPrivateKey'>

export interface WalletTransaction {
  id: string
  walletId: string
  swarmdockTaskId?: string | null
  amount: string
  direction: 'in' | 'out'
  txHash?: string | null
  status: 'pending' | 'confirmed' | 'failed'
  createdAt: number
}
