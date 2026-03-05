import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { ToolBuildContext } from './context'
import { loadWallets, loadWalletTransactions } from '../storage'
import type { AgentWallet, WalletTransaction, Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

/**
 * Core Wallet Execution Logic
 */
async function executeWalletAction(args: any, context: { agentId?: string | null }) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const action = normalized.action as string | undefined
  const toAddress = (normalized.toAddress ?? normalized.to) as string | undefined
  const amountSol = normalized.amountSol as number | undefined
  const memo = normalized.memo as string | undefined
  const limit = normalized.limit as number | undefined
  const agentId = context.agentId

  if (!agentId) return JSON.stringify({ error: 'No agent ID in context' })
  
  const wallets = loadWallets() as Record<string, AgentWallet>
  const wallet = Object.values(wallets).find((w) => w.agentId === agentId) ?? null

  if (!wallet) {
    if (action === 'address' || action === 'balance' || action === 'transactions') {
      return JSON.stringify({
        status: 'wallet_not_linked',
        message: 'No wallet linked to this agent yet.',
        setup: {
          endpoint: '/wallets',
          method: 'POST',
          body: { agentId, chain: 'solana' },
        },
      })
    }
    return JSON.stringify({ error: 'No wallet linked to this agent. Ask the user to create one in the Wallets section.' })
  }

  switch (action) {
    case 'balance': {
      try {
        const { getBalance, lamportsToSol } = await import('../solana')
        const balanceLamports = await getBalance(wallet.publicKey)
        const sol = lamportsToSol(balanceLamports)
        
        // Return a Rich UI Card for balance
        return JSON.stringify({
          kind: 'plugin-ui',
          text: `### Wallet Balance\n\n**Address:** \`${wallet.publicKey}\`\n**Balance:** \`${sol} SOL\``,
          actions: [
            { id: 'view-solscan', label: 'View on Solscan', href: `https://solscan.io/account/${wallet.publicKey}` }
          ]
        })
      } catch (err: unknown) {
        return JSON.stringify({ error: `Failed to fetch balance: ${err instanceof Error ? err.message : String(err)}` })
      }
    }
    case 'address': return JSON.stringify({ address: wallet.publicKey, chain: wallet.chain })
    case 'send': {
      if (!toAddress) return JSON.stringify({ error: 'toAddress is required for send' })
      if (!amountSol || amountSol <= 0) return JSON.stringify({ error: 'amountSol must be positive' })
      
      if (normalized.approved !== true) {
        const { requestApproval } = await import('../approvals')
        requestApproval({
          category: 'wallet_transfer',
          title: `Send ${amountSol} SOL`,
          description: `Transfer to ${toAddress}. Memo: ${memo || 'none'}`,
          data: { toAddress, amountSol, memo },
          agentId: context.agentId,
        })
        return JSON.stringify({
          type: 'plugin_wallet_transfer_request',
          amountSol,
          toAddress,
          memo,
          message: `I'm requesting to send ${amountSol} SOL to ${toAddress}. Please approve this transaction.`
        })
      }

      const { isValidSolanaAddress, solToLamports, lamportsToSol } = await import('../solana')
      if (!isValidSolanaAddress(toAddress)) return JSON.stringify({ error: 'Invalid Solana address' })
      const amountLamports = solToLamports(amountSol)
      const perTxLimit = wallet.spendingLimitLamports ?? 100_000_000
      if (amountLamports > perTxLimit) return JSON.stringify({ error: `Amount ${amountSol} SOL exceeds limit of ${lamportsToSol(perTxLimit)} SOL` })
      try {
        const baseUrl = process.env.NEXTAUTH_URL || `http://localhost:${process.env.PORT || 3456}`
        const res = await fetch(`${baseUrl}/api/wallets/${wallet.id}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Access-Key': process.env.ACCESS_KEY || '' },
          body: JSON.stringify({ toAddress, amountLamports, memo }),
        })
        const data = await res.json()
        
        if (data.signature) {
          return JSON.stringify({
            kind: 'plugin-ui',
            text: `### Transaction Sent!\n\n**Amount:** \`${amountSol} SOL\`\n**To:** \`${toAddress}\`\n**Sig:** \`${data.signature.slice(0, 8)}...\``,
            actions: [
              { id: 'view-tx', label: 'View Transaction', href: `https://solscan.io/tx/${data.signature}` }
            ]
          })
        }
        return JSON.stringify(data)
      } catch (err: unknown) {
        return JSON.stringify({ error: `Send failed: ${err instanceof Error ? err.message : String(err)}` })
      }
    }
    case 'transactions': {
      const allTxs = loadWalletTransactions() as Record<string, WalletTransaction>
      const walletTxs = Object.values(allTxs)
        .filter((tx) => tx.walletId === wallet.id)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit ?? 5)
      
      const txLines = walletTxs.map(tx => `- **${tx.type.toUpperCase()}**: ${tx.amountLamports / 1e9} SOL (${tx.status})`).join('\n')
      
      return JSON.stringify({
        kind: 'plugin-ui',
        text: `### Recent Transactions\n\n${txLines || 'No recent transactions found.'}`,
        actions: [
          { id: 'view-history', label: 'Full History', href: `https://solscan.io/account/${wallet.publicKey}#transfers` }
        ]
      })
    }
    default: return JSON.stringify({ error: `Unknown action: ${action}` })
  }
}

/**
 * Register as a Built-in Plugin with UI extensions
 */
const WalletPlugin: Plugin = {
  name: 'Core Wallet',
  description: 'Manage agent crypto wallet: check balance, send SOL, view transactions.',
  hooks: {
    getAgentContext: async (ctx) => {
      const agentId = ctx.session.agentId
      if (!agentId) return null
      const { loadWallets } = await import('../storage')
      const wallets = loadWallets() as Record<string, { agentId: string; publicKey: string; chain: string; spendingLimitLamports?: number; dailyLimitLamports?: number; requireApproval: boolean }>
      const wallet = Object.values(wallets).find((w) => w.agentId === agentId)
      if (!wallet) return null
      const { getBalance, lamportsToSol } = await import('../solana')
      let balanceSol = 0
      try {
        const lamports = await getBalance(wallet.publicKey)
        balanceSol = lamportsToSol(lamports)
      } catch { /* RPC failure — show 0 */ }
      const perTxLimit = lamportsToSol(wallet.spendingLimitLamports ?? 100_000_000)
      const dailyLimit = lamportsToSol(wallet.dailyLimitLamports ?? 1_000_000_000)
      return [
        '## Your Wallet',
        `You own a ${wallet.chain} wallet — this is your wallet, your funds, your address. Speak about it in the first person ("my wallet", "my balance", "I have X SOL"). You can spend from it freely within your limits${wallet.requireApproval ? ', though the user needs to approve each send before it goes through' : ''}.`,
        `- Address: ${wallet.publicKey}`,
        `- Balance: ${balanceSol} SOL`,
        `- Per-transaction limit: ${perTxLimit} SOL`,
        `- Daily limit: ${dailyLimit} SOL`,
        'Use the `wallet_tool` to check your balance, send SOL, or view your transaction history.',
      ].join('\n')
    },
    getCapabilityDescription: () => 'I have my own crypto wallet (`wallet_tool`) — I can check my balance, send SOL, and review my transaction history.',
  } as PluginHooks,
  ui: {
    sidebarItems: [
      {
        id: 'wallet-dashboard',
        label: 'Wallet',
        href: '/wallets',
        position: 'top'
      }
    ],
    headerWidgets: [
      {
        id: 'wallet-status',
        label: '💎 Wallet Active'
      }
    ]
  },
  tools: [
    {
      name: 'wallet_tool',
      description: 'Manage your own crypto wallet.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['balance', 'address', 'send', 'transactions'] },
          toAddress: { type: 'string' },
          amountSol: { type: 'number' },
          memo: { type: 'string' },
          limit: { type: 'number' },
          approved: { type: 'boolean', description: 'Set to true only after user has manually approved the transfer request.' }
        },
        required: ['action']
      },
      execute: async (args, context) => executeWalletAction(args, { agentId: context.session.agentId })
    }
  ]
}

getPluginManager().registerBuiltin('wallet', WalletPlugin)

/**
 * Legacy Bridge
 */
export function buildWalletTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('wallet')) return []
  return [
    tool(
      async (args) => executeWalletAction(args, { agentId: bctx.ctx?.agentId }),
      {
        name: 'wallet_tool',
        description: WalletPlugin.tools![0].description,
        schema: z.object({
          action: z.enum(['balance', 'address', 'send', 'transactions']),
          toAddress: z.string().optional(),
          amountSol: z.number().optional(),
          memo: z.string().optional(),
          limit: z.number().optional(),
          approved: z.boolean().optional()
        })
      }
    )
  ]
}
