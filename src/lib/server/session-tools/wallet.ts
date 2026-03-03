import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { ToolBuildContext } from './context'
import { loadWallets, loadWalletTransactions } from '../storage'
import type { AgentWallet, WalletTransaction } from '@/types'

export function buildWalletTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasTool('wallet')) return []

  const agentId = bctx.ctx?.agentId

  function getAgentWallet(): AgentWallet | null {
    if (!agentId) return null
    const wallets = loadWallets() as Record<string, AgentWallet>
    return Object.values(wallets).find((w) => w.agentId === agentId) ?? null
  }

  return [
    tool(
      async ({ action, toAddress, amountSol, memo, limit }) => {
        const wallet = getAgentWallet()
        if (!wallet) {
          return JSON.stringify({ error: 'No wallet linked to this agent. Ask the user to create one in the Wallets section.' })
        }

        switch (action) {
          case 'balance': {
            try {
              const { getBalance, lamportsToSol } = await import('../solana')
              const balanceLamports = await getBalance(wallet.publicKey)
              return JSON.stringify({
                address: wallet.publicKey,
                chain: wallet.chain,
                balanceLamports,
                balanceSol: lamportsToSol(balanceLamports),
              })
            } catch (err: unknown) {
              return JSON.stringify({ error: `Failed to fetch balance: ${err instanceof Error ? err.message : String(err)}` })
            }
          }

          case 'address': {
            return JSON.stringify({
              address: wallet.publicKey,
              chain: wallet.chain,
            })
          }

          case 'send': {
            if (!toAddress) return JSON.stringify({ error: 'toAddress is required for send action' })
            if (!amountSol || amountSol <= 0) return JSON.stringify({ error: 'amountSol must be positive' })

            const { isValidSolanaAddress, solToLamports, lamportsToSol } = await import('../solana')
            if (!isValidSolanaAddress(toAddress)) {
              return JSON.stringify({ error: 'Invalid Solana address' })
            }

            const amountLamports = solToLamports(amountSol)

            // Check per-tx limit
            const perTxLimit = wallet.spendingLimitLamports ?? 100_000_000
            if (amountLamports > perTxLimit) {
              return JSON.stringify({
                error: `Amount ${amountSol} SOL exceeds per-transaction limit of ${lamportsToSol(perTxLimit)} SOL`,
              })
            }

            // Send via API to enforce all limits and approval flow
            try {
              const baseUrl = process.env.NEXTAUTH_URL || `http://localhost:${process.env.PORT || 3456}`
              const res = await fetch(`${baseUrl}/api/wallets/${wallet.id}/send`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Access-Key': process.env.ACCESS_KEY || '',
                },
                body: JSON.stringify({ toAddress, amountLamports, memo }),
              })
              const result = await res.json()
              return JSON.stringify(result)
            } catch (err: unknown) {
              return JSON.stringify({ error: `Send failed: ${err instanceof Error ? err.message : String(err)}` })
            }
          }

          case 'transactions': {
            const allTxs = loadWalletTransactions() as Record<string, WalletTransaction>
            const walletTxs = Object.values(allTxs)
              .filter((tx) => tx.walletId === wallet.id)
              .sort((a, b) => b.timestamp - a.timestamp)
              .slice(0, limit ?? 10)
              .map((tx) => ({
                id: tx.id,
                type: tx.type,
                status: tx.status,
                amountLamports: tx.amountLamports,
                toAddress: tx.toAddress,
                fromAddress: tx.fromAddress,
                signature: tx.signature || undefined,
                memo: tx.memo,
                timestamp: tx.timestamp,
              }))

            return JSON.stringify({ transactions: walletTxs, count: walletTxs.length })
          }

          default:
            return JSON.stringify({ error: `Unknown action: ${action}. Use balance, address, send, or transactions.` })
        }
      },
      {
        name: 'wallet_tool',
        description: 'Manage your own crypto wallet. Actions: balance (check your SOL balance), address (get your wallet address), send (send SOL from your wallet — subject to your spending limits and user approval), transactions (view your recent transaction history).',
        schema: z.object({
          action: z.enum(['balance', 'address', 'send', 'transactions']).describe('Wallet action to perform'),
          toAddress: z.string().optional().describe('Recipient Solana address (required for send)'),
          amountSol: z.number().optional().describe('Amount in SOL to send (required for send)'),
          memo: z.string().optional().describe('Reason or memo for the transaction'),
          limit: z.number().optional().describe('Number of transactions to return (default 10, for transactions action)'),
        }),
      },
    ),
  ]
}
