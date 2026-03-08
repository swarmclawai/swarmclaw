import { NextResponse } from 'next/server'
import { loadWallets, upsertWallet, deleteWallet as deleteWalletFromStore, loadAgents, saveAgents } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { getWalletLimitAtomic, normalizeAtomicString } from '@/lib/wallet'
import type { AgentWallet, WalletAssetBalance, WalletPortfolioSummary } from '@/types'
import { buildEmptyWalletPortfolio } from '@/lib/server/wallet-portfolio'
import {
  getAgentActiveWalletId,
  getWalletPortfolioSnapshot,
  linkWalletToAgent,
  setAgentActiveWallet,
  stripWalletPrivateKey,
  unlinkWalletFromAgent,
} from '@/lib/server/wallet-service'
export const dynamic = 'force-dynamic'
const WALLET_DETAIL_PORTFOLIO_TIMEOUT_MS = 2500

function withPortfolio(
  wallet: AgentWallet,
  portfolio: {
    balanceAtomic: string
    balanceFormatted: string
    balanceSymbol: string
    balanceDisplay: string
    balanceLamports?: number
    balanceSol?: number
    assets: WalletAssetBalance[]
    summary: WalletPortfolioSummary
  },
  isActive: boolean,
) {
  return {
    ...stripWalletPrivateKey(wallet as unknown as Record<string, unknown>),
    balanceAtomic: portfolio.balanceAtomic,
    balanceFormatted: portfolio.balanceFormatted,
    balanceSymbol: portfolio.balanceSymbol,
    balanceDisplay: portfolio.balanceDisplay,
    balanceLamports: portfolio.balanceLamports,
    balanceSol: portfolio.balanceSol,
    assets: portfolio.assets,
    portfolioSummary: portfolio.summary,
    isActive,
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const wallets = loadWallets() as Record<string, AgentWallet>
  const wallet = wallets[id]
  if (!wallet) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })

  let portfolio = buildEmptyWalletPortfolio(wallet)
  try {
    portfolio = await getWalletPortfolioSnapshot(wallet, {
      timeoutMs: WALLET_DETAIL_PORTFOLIO_TIMEOUT_MS,
      allowStale: true,
    })
  } catch {
    // RPC failure — return 0
  }

  const agents = loadAgents()
  const isActive = getAgentActiveWalletId(agents[wallet.agentId]) === wallet.id
  return NextResponse.json(withPortfolio(wallet, portfolio, isActive))
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const wallets = loadWallets() as Record<string, AgentWallet>
  const wallet = wallets[id]
  if (!wallet) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })

  const body = await req.json()
  const shouldMakeActive = body.makeActive === true

  // Reassign wallet to a different agent
  if (typeof body.agentId === 'string' && body.agentId !== wallet.agentId) {
    const agents = loadAgents()
    const newAgent = agents[body.agentId]
    if (!newAgent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

    // Only one wallet per chain per agent.
    const allWallets = loadWallets() as Record<string, AgentWallet>
    const conflict = Object.values(allWallets).find((w) => w.agentId === body.agentId && w.id !== id && w.chain === wallet.chain)
    if (conflict) return NextResponse.json({ error: `Target agent already has a ${wallet.chain} wallet` }, { status: 409 })

    const oldAgent = agents[wallet.agentId]
    if (oldAgent) {
      unlinkWalletFromAgent(oldAgent, id)
      oldAgent.updatedAt = Date.now()
      agents[wallet.agentId] = oldAgent
    }

    linkWalletToAgent(newAgent, id, shouldMakeActive || getAgentActiveWalletId(newAgent) == null)
    newAgent.updatedAt = Date.now()
    agents[body.agentId] = newAgent
    saveAgents(agents)
    notify('agents')

    wallet.agentId = body.agentId
  } else if (shouldMakeActive) {
    const agents = loadAgents()
    const agent = agents[wallet.agentId]
    if (agent) {
      setAgentActiveWallet(agent, id)
      agent.updatedAt = Date.now()
      agents[wallet.agentId] = agent
      saveAgents(agents)
      notify('agents')
    }
  }

  if (body.label !== undefined) wallet.label = body.label
  if (body.spendingLimitAtomic !== undefined || body.spendingLimitLamports !== undefined) {
    wallet.spendingLimitAtomic = normalizeAtomicString(body.spendingLimitAtomic ?? body.spendingLimitLamports, getWalletLimitAtomic(wallet, 'perTx'))
  }
  if (body.dailyLimitAtomic !== undefined || body.dailyLimitLamports !== undefined) {
    wallet.dailyLimitAtomic = normalizeAtomicString(body.dailyLimitAtomic ?? body.dailyLimitLamports, getWalletLimitAtomic(wallet, 'daily'))
  }
  if (typeof body.requireApproval === 'boolean') wallet.requireApproval = body.requireApproval
  wallet.updatedAt = Date.now()

  upsertWallet(id, wallet)
  notify('wallets')

  return NextResponse.json(stripWalletPrivateKey(wallet as unknown as Record<string, unknown>))
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const wallets = loadWallets() as Record<string, AgentWallet>
  const wallet = wallets[id]
  if (!wallet) return NextResponse.json({ error: 'Wallet not found' }, { status: 404 })

  // Check if balance > 0 and warn
  let portfolio = buildEmptyWalletPortfolio(wallet)
  try {
    portfolio = await getWalletPortfolioSnapshot(wallet, {
      timeoutMs: WALLET_DETAIL_PORTFOLIO_TIMEOUT_MS,
      allowStale: true,
    })
  } catch { /* ignore */ }

  // Unlink from agent
  const agents = loadAgents()
  const agent = agents[wallet.agentId]
  if (agent) {
    unlinkWalletFromAgent(agent, id)
    agent.updatedAt = Date.now()
    agents[wallet.agentId] = agent
    saveAgents(agents)
    notify('agents')
  }

  deleteWalletFromStore(id)
  notify('wallets')

  return NextResponse.json({
    ok: true,
    warning: portfolio.summary.nonZeroAssets > 0
      ? `Wallet still had ${portfolio.summary.nonZeroAssets} asset${portfolio.summary.nonZeroAssets === 1 ? '' : 's'} remaining, including ${portfolio.balanceDisplay}`
      : undefined,
  })
}
