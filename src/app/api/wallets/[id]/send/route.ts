import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadWallets, upsertWalletTransaction } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import type { AgentWallet, WalletTransaction } from '@/types'
import {
  normalizeAtomicString,
} from '@/lib/wallet/wallet'
import { isValidWalletAddress, sendWalletNativeAsset, validateWalletSendLimits } from '@/lib/server/wallet/wallet-service'
import { errorMessage } from '@/lib/shared-utils'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const wallets = loadWallets() as Record<string, AgentWallet>
  const wallet = wallets[id]
  if (!wallet) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })

  const body = await req.json()
  const toAddress = typeof body.toAddress === 'string' ? body.toAddress.trim() : ''
  const amountAtomic = normalizeAtomicString(body.amountAtomic ?? body.amountLamports, '0')
  const memo = typeof body.memo === 'string' ? body.memo.slice(0, 500) : undefined

  if (!toAddress || !isValidWalletAddress(wallet.chain, toAddress)) {
    return NextResponse.json({ error: 'Invalid recipient address' }, { status: 400 })
  }
  const limitError = validateWalletSendLimits({ wallet, amountAtomic })
  if (limitError) {
    return NextResponse.json({ error: limitError }, { status: limitError === 'Amount must be positive' ? 400 : 403 })
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
      amountAtomic,
      amountLamports: wallet.chain === 'solana' ? Number.parseInt(amountAtomic, 10) : undefined,
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
    const { signature, feeAtomic } = await sendWalletNativeAsset(wallet, toAddress, amountAtomic)
    const confirmedTx: WalletTransaction = {
      id: txId,
      walletId: id,
      agentId: wallet.agentId,
      chain: wallet.chain,
      type: 'send',
      signature,
      fromAddress: wallet.publicKey,
      toAddress,
      amountAtomic,
      amountLamports: wallet.chain === 'solana' ? Number.parseInt(amountAtomic, 10) : undefined,
      feeAtomic,
      feeLamports: wallet.chain === 'solana' && feeAtomic ? Number.parseInt(feeAtomic, 10) : undefined,
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
      amountAtomic,
      amountLamports: wallet.chain === 'solana' ? Number.parseInt(amountAtomic, 10) : undefined,
      status: 'failed',
      memo,
      timestamp: now,
    }
    upsertWalletTransaction(txId, failedTx)
    notify('wallets')
    return NextResponse.json({
      error: errorMessage(err),
      transactionId: txId,
      status: 'failed',
    }, { status: 500 })
  }
}
