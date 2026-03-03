import { NextResponse } from 'next/server'
import { loadWallets, loadWalletBalanceHistory } from '@/lib/server/storage'
import type { AgentWallet, WalletBalanceSnapshot } from '@/types'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const wallets = loadWallets() as Record<string, AgentWallet>
  const wallet = wallets[id]
  if (!wallet) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })

  const allSnapshots = loadWalletBalanceHistory() as Record<string, WalletBalanceSnapshot>
  const walletSnapshots = Object.values(allSnapshots)
    .filter((s) => s.walletId === id)
    .sort((a, b) => a.timestamp - b.timestamp)

  return NextResponse.json(walletSnapshots)
}
