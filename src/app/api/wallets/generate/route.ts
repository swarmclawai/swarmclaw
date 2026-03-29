import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { generateWallet, WalletServiceError } from '@/lib/server/wallets/wallet-service'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody(req)
  if (error) return error
  try {
    const wallet = await generateWallet({
      agentId: typeof body.agentId === 'string' ? body.agentId : '',
      label: typeof body.label === 'string' ? body.label : undefined,
    })
    return NextResponse.json(wallet, { status: 201 })
  } catch (err) {
    if (err instanceof WalletServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    const message = err instanceof Error ? err.message : 'Failed to generate wallet'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
