import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadWallets, upsertWallet, loadAgents, saveAgents } from '@/lib/server/storage'
import { generateSolanaKeypair } from '@/lib/server/solana'
import { notify } from '@/lib/server/ws-hub'
import type { AgentWallet, WalletChain } from '@/types'
export const dynamic = 'force-dynamic'

/** Strip encryptedPrivateKey from wallet for safe API responses */
function stripPrivateKey(wallet: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(wallet).filter(([k]) => k !== 'encryptedPrivateKey'))
}

export async function GET() {
  const wallets = loadWallets() as Record<string, AgentWallet>
  const safe = Object.fromEntries(
    Object.entries(wallets).map(([id, w]) => [id, stripPrivateKey(w as unknown as Record<string, unknown>)]),
  )
  return NextResponse.json(safe)
}

export async function POST(req: Request) {
  const body = await req.json()
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
  if (!agentId) {
    return NextResponse.json({ error: 'agentId is required' }, { status: 400 })
  }

  const agents = loadAgents()
  if (!agents[agentId]) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 })
  }

  // Check agent doesn't already have a wallet
  const existing = loadWallets() as Record<string, AgentWallet>
  const hasWallet = Object.values(existing).some((w) => w.agentId === agentId)
  if (hasWallet) {
    return NextResponse.json({ error: 'Agent already has a wallet' }, { status: 409 })
  }

  const chain: WalletChain = body.chain === 'solana' ? 'solana' : 'solana' // extensible later
  const { publicKey, encryptedPrivateKey } = generateSolanaKeypair()

  const id = genId()
  const now = Date.now()

  const wallet: AgentWallet = {
    id,
    agentId,
    chain,
    publicKey,
    encryptedPrivateKey,
    label: typeof body.label === 'string' ? body.label : undefined,
    spendingLimitLamports: typeof body.spendingLimitLamports === 'number' ? body.spendingLimitLamports : 100_000_000,
    dailyLimitLamports: typeof body.dailyLimitLamports === 'number' ? body.dailyLimitLamports : 1_000_000_000,
    requireApproval: body.requireApproval !== false,
    createdAt: now,
    updatedAt: now,
  }

  upsertWallet(id, wallet)

  // Link wallet to agent
  const agent = agents[agentId]
  agent.walletId = id
  agent.updatedAt = now
  agents[agentId] = agent
  saveAgents(agents)

  notify('wallets')
  notify('agents')

  return NextResponse.json(stripPrivateKey(wallet as unknown as Record<string, unknown>))
}
