import { NextResponse } from 'next/server'
import { loadWallets, loadWalletTransactions, upsertWalletTransaction } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import type { AgentWallet, WalletTransaction } from '@/types'
import { getWalletAtomicAmount } from '@/lib/wallet/wallet'
import { sendWalletNativeAsset, validateWalletSendLimits } from '@/lib/server/wallet/wallet-service'
import { errorMessage } from '@/lib/shared-utils'
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
    const limitError = validateWalletSendLimits({ wallet, amountAtomic: getWalletAtomicAmount(tx), excludeTransactionId: transactionId })
    if (limitError) {
      tx.status = 'failed'
      upsertWalletTransaction(transactionId, tx)
      notify('wallets')
      return NextResponse.json({
        error: limitError,
        transactionId,
        status: 'failed',
      }, { status: limitError === 'Amount must be positive' ? 400 : 403 })
    }

    const { signature, feeAtomic } = await sendWalletNativeAsset(wallet, tx.toAddress, getWalletAtomicAmount(tx))
    tx.status = 'confirmed'
    tx.signature = signature
    tx.feeAtomic = feeAtomic
    tx.feeLamports = wallet.chain === 'solana' && feeAtomic ? Number.parseInt(feeAtomic, 10) : undefined
    tx.approvedBy = 'user'
    upsertWalletTransaction(transactionId, tx)
    notify('wallets')
    return NextResponse.json({ status: 'confirmed', transactionId, signature })
  } catch (err: unknown) {
    tx.status = 'failed'
    upsertWalletTransaction(transactionId, tx)
    notify('wallets')
    return NextResponse.json({
      error: errorMessage(err),
      transactionId,
      status: 'failed',
    }, { status: 500 })
  }
}
