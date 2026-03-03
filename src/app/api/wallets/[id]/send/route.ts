import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadWallets, loadWalletTransactions, upsertWalletTransaction } from '@/lib/server/storage'
import { sendSol, isValidSolanaAddress, lamportsToSol } from '@/lib/server/solana'
import { notify } from '@/lib/server/ws-hub'
import type { AgentWallet, WalletTransaction } from '@/types'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const wallets = loadWallets() as Record<string, AgentWallet>
  const wallet = wallets[id]
  if (!wallet) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })

  const body = await req.json()
  const toAddress = typeof body.toAddress === 'string' ? body.toAddress.trim() : ''
  const amountLamports = typeof body.amountLamports === 'number' ? Math.floor(body.amountLamports) : 0
  const memo = typeof body.memo === 'string' ? body.memo.slice(0, 500) : undefined

  if (!toAddress || !isValidSolanaAddress(toAddress)) {
    return NextResponse.json({ error: 'Invalid recipient address' }, { status: 400 })
  }
  if (amountLamports <= 0) {
    return NextResponse.json({ error: 'Amount must be positive' }, { status: 400 })
  }

  // Per-tx spending limit
  const perTxLimit = wallet.spendingLimitLamports ?? 100_000_000
  if (amountLamports > perTxLimit) {
    return NextResponse.json({
      error: `Amount ${lamportsToSol(amountLamports)} SOL exceeds per-transaction limit of ${lamportsToSol(perTxLimit)} SOL`,
    }, { status: 403 })
  }

  // 24h rolling daily limit
  const dailyLimit = wallet.dailyLimitLamports ?? 1_000_000_000
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
  const allTxs = loadWalletTransactions() as Record<string, WalletTransaction>
  const recentSends = Object.values(allTxs).filter(
    (tx) => tx.walletId === id && tx.type === 'send' && tx.status === 'confirmed' && tx.timestamp > oneDayAgo,
  )
  const dailySpent = recentSends.reduce((sum, tx) => sum + tx.amountLamports, 0)
  if (dailySpent + amountLamports > dailyLimit) {
    return NextResponse.json({
      error: `Daily limit exceeded. Spent ${lamportsToSol(dailySpent)} SOL in last 24h, limit is ${lamportsToSol(dailyLimit)} SOL`,
    }, { status: 403 })
  }

  const txId = genId(8)
  const now = Date.now()

  // If requireApproval, create pending tx and return it
  if (wallet.requireApproval) {
    const pendingTx: WalletTransaction = {
      id: txId,
      walletId: id,
      agentId: wallet.agentId,
      chain: wallet.chain,
      type: 'send',
      signature: '',
      fromAddress: wallet.publicKey,
      toAddress,
      amountLamports,
      status: 'pending_approval',
      memo,
      timestamp: now,
    }
    upsertWalletTransaction(txId, pendingTx)
    notify('wallets')
    return NextResponse.json({ status: 'pending_approval', transactionId: txId, message: 'Transaction requires user approval' })
  }

  // Auto-approved — sign and submit
  try {
    const { signature, fee } = await sendSol(wallet.encryptedPrivateKey, toAddress, amountLamports)
    const confirmedTx: WalletTransaction = {
      id: txId,
      walletId: id,
      agentId: wallet.agentId,
      chain: wallet.chain,
      type: 'send',
      signature,
      fromAddress: wallet.publicKey,
      toAddress,
      amountLamports,
      feeLamports: fee,
      status: 'confirmed',
      memo,
      approvedBy: 'auto',
      timestamp: now,
    }
    upsertWalletTransaction(txId, confirmedTx)
    notify('wallets')
    return NextResponse.json({ status: 'confirmed', transactionId: txId, signature })
  } catch (err: unknown) {
    const failedTx: WalletTransaction = {
      id: txId,
      walletId: id,
      agentId: wallet.agentId,
      chain: wallet.chain,
      type: 'send',
      signature: '',
      fromAddress: wallet.publicKey,
      toAddress,
      amountLamports,
      status: 'failed',
      memo,
      timestamp: now,
    }
    upsertWalletTransaction(txId, failedTx)
    notify('wallets')
    return NextResponse.json({
      error: err instanceof Error ? err.message : String(err),
      transactionId: txId,
      status: 'failed',
    }, { status: 500 })
  }
}
