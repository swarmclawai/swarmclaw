import { NextResponse } from 'next/server'
import { loadWallets, loadWalletTransactions, upsertWalletTransaction } from '@/lib/server/storage'
import { sendSol } from '@/lib/server/solana'
import { notify } from '@/lib/server/ws-hub'
import type { AgentWallet, WalletTransaction } from '@/types'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const wallets = loadWallets() as Record<string, AgentWallet>
  const wallet = wallets[id]
  if (!wallet) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })

  const body = await req.json()
  const transactionId = typeof body.transactionId === 'string' ? body.transactionId.trim() : ''
  const decision = body.decision as 'approve' | 'deny'

  if (!transactionId) {
    return NextResponse.json({ error: 'transactionId is required' }, { status: 400 })
  }
  if (decision !== 'approve' && decision !== 'deny') {
    return NextResponse.json({ error: 'decision must be "approve" or "deny"' }, { status: 400 })
  }

  const allTxs = loadWalletTransactions() as Record<string, WalletTransaction>
  const tx = allTxs[transactionId]
  if (!tx || tx.walletId !== id) {
    return NextResponse.json({ error: 'Transaction not found' }, { status: 404 })
  }
  if (tx.status !== 'pending_approval') {
    return NextResponse.json({ error: `Transaction is already ${tx.status}` }, { status: 409 })
  }

  if (decision === 'deny') {
    tx.status = 'denied'
    tx.approvedBy = 'user'
    upsertWalletTransaction(transactionId, tx)
    notify('wallets')
    return NextResponse.json({ status: 'denied', transactionId })
  }

  // Approve — sign and submit
  try {
    const { signature, fee } = await sendSol(wallet.encryptedPrivateKey, tx.toAddress, tx.amountLamports)
    tx.status = 'confirmed'
    tx.signature = signature
    tx.feeLamports = fee
    tx.approvedBy = 'user'
    upsertWalletTransaction(transactionId, tx)
    notify('wallets')
    return NextResponse.json({ status: 'confirmed', transactionId, signature })
  } catch (err: unknown) {
    tx.status = 'failed'
    upsertWalletTransaction(transactionId, tx)
    notify('wallets')
    return NextResponse.json({
      error: err instanceof Error ? err.message : String(err),
      transactionId,
      status: 'failed',
    }, { status: 500 })
  }
}
