import type { WalletTransaction, WalletTransactionStatus } from '@/types'

export type WalletTransactionFilter = 'all' | 'confirmed' | 'pending' | 'failed' | 'send' | 'receive' | 'swap'

export function getWalletTransactionStatusGroup(status: WalletTransactionStatus): 'confirmed' | 'pending' | 'failed' {
  if (status === 'confirmed') return 'confirmed'
  if (status === 'pending' || status === 'pending_approval') return 'pending'
  return 'failed'
}

export function matchesWalletTransactionFilter(tx: WalletTransaction, filter: WalletTransactionFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'send' || filter === 'receive' || filter === 'swap') return tx.type === filter
  return getWalletTransactionStatusGroup(tx.status) === filter
}

export function matchesWalletTransactionQuery(tx: WalletTransaction, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  const haystack = [
    tx.id,
    tx.signature,
    tx.memo || '',
    tx.fromAddress,
    tx.toAddress,
    tx.status,
    tx.type,
    tx.tokenMint || '',
    tx.approvedBy || '',
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(normalized)
}

export function filterWalletTransactions(
  transactions: WalletTransaction[],
  options?: { filter?: WalletTransactionFilter; query?: string },
): WalletTransaction[] {
  const filter = options?.filter || 'all'
  const query = options?.query || ''
  return transactions.filter((tx) => matchesWalletTransactionFilter(tx, filter) && matchesWalletTransactionQuery(tx, query))
}
