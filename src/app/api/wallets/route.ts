import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { listWalletsSafe, createWallet, WalletServiceError } from '@/lib/server/wallets/wallet-service'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(listWalletsSafe())
}

export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody(req)
  if (error) return error
  try {
    const wallet = await createWallet({
      agentId: typeof body.agentId === 'string' ? body.agentId : '',
      walletAddress: typeof body.walletAddress === 'string' ? body.walletAddress : '',
      label: typeof body.label === 'string' ? body.label : undefined,
    })
    return NextResponse.json(wallet, { status: 201 })
  } catch (err) {
    if (err instanceof WalletServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    const message = err instanceof Error ? err.message : 'Failed to create wallet'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
