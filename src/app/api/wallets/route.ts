import { NextResponse } from 'next/server'
import { loadAgents, loadSettings, loadWallets } from '@/lib/server/storage'
import { createAgentWallet, getAgentActiveWalletId, getWalletPortfolioSnapshot, stripWalletPrivateKey } from '@/lib/server/wallet/wallet-service'
import { buildEmptyWalletPortfolio } from '@/lib/server/wallet/wallet-portfolio'
import type { AgentWallet, WalletPortfolioSummary } from '@/types'
import { errorMessage } from '@/lib/shared-utils'
export const dynamic = 'force-dynamic'
const WALLET_LIST_PORTFOLIO_TIMEOUT_MS = 1500

function withPortfolio(
  wallet: AgentWallet,
  portfolio: {
    balanceAtomic: string
    balanceFormatted: string
    balanceSymbol: string
    balanceDisplay: string
    balanceLamports?: number
    balanceSol?: number
    assets: unknown[]
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

export async function GET(req: Request) {
  const wallets = loadWallets() as Record<string, AgentWallet>
  const agents = loadAgents()
  const { searchParams } = new URL(req.url)
  const agentId = searchParams.get('agentId')?.trim() || ''
  const walletEntries = Object.entries(wallets)
    .filter(([, wallet]) => !agentId || wallet.agentId === agentId)
  const entries = await Promise.all(
    walletEntries.map(async ([id, wallet]) => {
      let portfolio = buildEmptyWalletPortfolio(wallet)
      try {
        portfolio = await getWalletPortfolioSnapshot(wallet, {
          timeoutMs: WALLET_LIST_PORTFOLIO_TIMEOUT_MS,
          allowStale: true,
        })
      } catch {
        // Slow or failed RPC discovery — return empty/stale portfolio for list view
      }
      const activeWalletId = getAgentActiveWalletId(agents[wallet.agentId])
      return [id, withPortfolio(wallet, portfolio, activeWalletId === wallet.id)] as const
    }),
  )
  return NextResponse.json(Object.fromEntries(entries))
}

export async function POST(req: Request) {
  const body = await req.json()
  const settings = loadSettings()
  try {
    const wallet = createAgentWallet({
      agentId: body.agentId,
      chain: body.chain,
      provider: body.provider,
      label: body.label,
      requireApproval: typeof body.requireApproval === 'boolean'
        ? body.requireApproval
        : settings.walletApprovalsEnabled !== false,
      spendingLimitAtomic: body.spendingLimitAtomic ?? body.spendingLimitLamports,
      dailyLimitAtomic: body.dailyLimitAtomic ?? body.dailyLimitLamports,
    })
    return NextResponse.json(stripWalletPrivateKey(wallet as unknown as Record<string, unknown>))
  } catch (err: unknown) {
    const message = errorMessage(err)
    if (message === 'agentId is required') {
      return NextResponse.json({ error: message }, { status: 400 })
    }
    if (/^Unsupported wallet chain or provider: /.test(message)) {
      return NextResponse.json({ error: message }, { status: 400 })
    }
    if (message === 'Agent not found') {
      return NextResponse.json({ error: message }, { status: 404 })
    }
    if (/^Agent already has a (solana|ethereum) wallet$/.test(message)) {
      return NextResponse.json({ error: message }, { status: 409 })
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
