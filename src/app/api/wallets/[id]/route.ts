import { NextResponse } from 'next/server'
import { loadWallets, upsertWallet, deleteWallet as deleteWalletFromStore, loadAgents, saveAgents } from '@/lib/server/storage'
import { getBalance, lamportsToSol } from '@/lib/server/solana'
import { notify } from '@/lib/server/ws-hub'
import type { AgentWallet } from '@/types'
export const dynamic = 'force-dynamic'

function stripPrivateKey(wallet: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(wallet).filter(([k]) => k !== 'encryptedPrivateKey'))
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const wallets = loadWallets() as Record<string, AgentWallet>
  const wallet = wallets[id]
  if (!wallet) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })

  // Fetch live on-chain balance
  let balanceLamports = 0
  let balanceSol = 0
  try {
    balanceLamports = await getBalance(wallet.publicKey)
    balanceSol = lamportsToSol(balanceLamports)
  } catch {
    // RPC failure — return 0
  }

  return NextResponse.json({
    ...stripPrivateKey(wallet as unknown as Record<string, unknown>),
    balanceLamports,
    balanceSol,
  })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const wallets = loadWallets() as Record<string, AgentWallet>
  const wallet = wallets[id]
  if (!wallet) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })

  const body = await req.json()

  // Reassign wallet to a different agent
  if (typeof body.agentId === 'string' && body.agentId !== wallet.agentId) {
    const agents = loadAgents()
    const newAgent = agents[body.agentId]
    if (!newAgent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

    // Check new agent doesn't already have a wallet
    const allWallets = loadWallets() as Record<string, AgentWallet>
    const conflict = Object.values(allWallets).find((w) => w.agentId === body.agentId && w.id !== id)
    if (conflict) return NextResponse.json({ error: 'Target agent already has a wallet' }, { status: 409 })

    // Unlink old agent
    const oldAgent = agents[wallet.agentId]
    if (oldAgent) {
      oldAgent.walletId = null
      oldAgent.updatedAt = Date.now()
      agents[wallet.agentId] = oldAgent
    }

    // Link new agent
    newAgent.walletId = id
    newAgent.updatedAt = Date.now()
    agents[body.agentId] = newAgent
    saveAgents(agents)
    notify('agents')

    wallet.agentId = body.agentId
  }

  if (body.label !== undefined) wallet.label = body.label
  if (typeof body.spendingLimitLamports === 'number') wallet.spendingLimitLamports = body.spendingLimitLamports
  if (typeof body.dailyLimitLamports === 'number') wallet.dailyLimitLamports = body.dailyLimitLamports
  if (typeof body.requireApproval === 'boolean') wallet.requireApproval = body.requireApproval
  wallet.updatedAt = Date.now()

  upsertWallet(id, wallet)
  notify('wallets')

  return NextResponse.json(stripPrivateKey(wallet as unknown as Record<string, unknown>))
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const wallets = loadWallets() as Record<string, AgentWallet>
  const wallet = wallets[id]
  if (!wallet) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })

  // Check if balance > 0 and warn
  let balanceLamports = 0
  try {
    balanceLamports = await getBalance(wallet.publicKey)
  } catch { /* ignore */ }

  if (balanceLamports > 0) {
    // Still delete, but include warning
  }

  // Unlink from agent
  const agents = loadAgents()
  const agent = agents[wallet.agentId]
  if (agent) {
    agent.walletId = null
    agent.updatedAt = Date.now()
    agents[wallet.agentId] = agent
    saveAgents(agents)
    notify('agents')
  }

  deleteWalletFromStore(id)
  notify('wallets')

  return NextResponse.json({
    ok: true,
    warning: balanceLamports > 0 ? `Wallet had ${lamportsToSol(balanceLamports)} SOL remaining` : undefined,
  })
}
