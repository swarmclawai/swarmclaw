import {
  loadWallets as loadWalletsStore,
  saveWallets as saveWalletsStore,
  loadWallet as loadWalletItem,
  upsertWallet,
  deleteWalletItem,
} from '@/lib/server/storage'
import type { AgentWallet } from '@/types/swarmdock'

export function loadWallets(): Record<string, AgentWallet> {
  return loadWalletsStore() as Record<string, AgentWallet>
}

export function loadWallet(id: string): AgentWallet | null {
  return loadWalletItem(id) as AgentWallet | null
}

export function saveWallet(id: string, wallet: AgentWallet): void {
  upsertWallet(id, wallet)
}

export function deleteWallet(id: string): void {
  deleteWalletItem(id)
}
