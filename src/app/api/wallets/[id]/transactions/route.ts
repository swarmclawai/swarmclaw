import { NextResponse } from 'next/server'
import { loadWallets, loadWalletTransactions } from '@/lib/server/storage'
import type { AgentWallet, WalletTransaction } from '@/types'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const wallets = loadWallets() as Record<string, AgentWallet>
  const wallet = wallets[id]
  if (!wallet) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })

  const allTxs = loadWalletTransactions() as Record<string, WalletTransaction>
  const walletTxs = Object.values(allTxs)
    .filter((tx) => tx.walletId === id)
    .sort((a, b) => b.timestamp - a.timestamp)

  return NextResponse.json(walletTxs)
}
