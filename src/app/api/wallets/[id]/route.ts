import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { getWalletSafe, removeWallet, updateWallet } from '@/lib/server/wallets/wallet-service'
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const wallet = getWalletSafe(id)
  if (!wallet) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })
  return NextResponse.json(wallet)
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: body, error } = await safeParseBody(req)
  if (error) return error
  const patch: Record<string, unknown> = {}
  if (typeof body.label === 'string') patch.label = body.label
  if (typeof body.spendingLimitUsdc === 'string' || body.spendingLimitUsdc === null) patch.spendingLimitUsdc = body.spendingLimitUsdc
  if (typeof body.dailyLimitUsdc === 'string' || body.dailyLimitUsdc === null) patch.dailyLimitUsdc = body.dailyLimitUsdc
  if (typeof body.requireApproval === 'boolean') patch.requireApproval = body.requireApproval
  const updated = updateWallet(id, patch)
  if (!updated) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })
  return NextResponse.json(updated)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const deleted = removeWallet(id)
  if (!deleted) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
