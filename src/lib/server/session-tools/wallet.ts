import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import crypto from 'node:crypto'

import type { ApprovalCategory, ApprovalRequest, Plugin, PluginHooks, WalletTransaction } from '@/types'
import { genId } from '@/lib/id'
import {
  formatWalletAmount,
  getWalletAssetSymbol,
  getWalletAtomicAmount,
  getWalletChainOrDefault,
  getWalletExplorerUrl,
  getWalletLimitAtomic,
  parseDisplayAmountToAtomic,
} from '@/lib/wallet/wallet'

import type { ToolBuildContext } from './context'
import { normalizeToolInputArgs } from './normalize-tool-args'
import type { SolanaCluster } from '../solana'
import { isLikelyRetryableSwapError, prepareEvmSwapPlan } from '../evm-swap'
import {
  callEthereumContract,
  encodeEthereumContractCall,
  getEvmNetworkConfig,
  sendEthereumTransaction,
  signEthereumMessage,
  signEthereumTransaction,
  signEthereumTypedData,
  simulateEthereumTransaction,
} from '../ethereum'
import { getPluginManager } from '../plugins'
import { loadAgents, loadWalletTransactions, upsertWalletTransaction } from '../storage'
import {
  getSolanaClusterLabel,
  normalizeSolanaCluster,
  sendSolanaTransaction,
  signSolanaMessage,
  signSolanaTransaction,
  simulateSolanaTransaction,
} from '../solana'
import { TOOL_CAPABILITY } from '../tool-planning'
import { clearWalletPortfolioCache } from '@/lib/server/wallet/wallet-portfolio'
import {
  createAgentWallet,
  getAgentActiveWalletId,
  getWalletByAgentId,
  getWalletPortfolioSnapshot,
  getWalletsByAgentId,
  isValidWalletAddress,
} from '@/lib/server/wallet/wallet-service'
import { errorMessage } from '@/lib/shared-utils'

const WALLET_TOOL_ACTIONS = [
  'setup',
  'balance',
  'address',
  'send',
  'transactions',
  'call_contract',
  'sign_message',
  'sign_typed_data',
  'encode_contract_call',
  'quote_swap',
  'simulate_transaction',
  'sign_transaction',
  'swap',
  'send_transaction',
] as const

type WalletToolAction = (typeof WALLET_TOOL_ACTIONS)[number]

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseJsonValue<T>(value: unknown, label: string): T | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    try {
      return JSON.parse(trimmed) as T
    } catch (err: unknown) {
      throw new Error(`${label} must be valid JSON: ${errorMessage(err)}`)
    }
  }
  return value as T
}

function parseRecordValue(value: unknown, label: string): Record<string, unknown> | undefined {
  const parsed = parseJsonValue<Record<string, unknown>>(value, label)
  if (parsed === undefined) return undefined
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object`)
  }
  return parsed
}

function parseArrayValue(value: unknown, label: string): unknown[] | undefined {
  const parsed = parseJsonValue<unknown[]>(value, label)
  if (parsed === undefined) return undefined
  if (!Array.isArray(parsed)) throw new Error(`${label} must be an array`)
  return parsed
}

function parseFunctionArgsValue(value: unknown, label: string): unknown[] | Record<string, unknown> | undefined {
  const parsed = parseJsonValue<unknown>(value, label)
  if (parsed === undefined) return undefined
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
  throw new Error(`${label} must be a JSON array or object`)
}

function pickFirstDefined(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key]
  }
  return undefined
}

function describeWalletAssetIdentity(asset: {
  isNative?: boolean
  contractAddress?: string
  tokenMint?: string
}): string {
  if (asset.isNative) return ''
  if (asset.contractAddress) return ` contract \`${asset.contractAddress}\``
  if (asset.tokenMint) return ` mint \`${asset.tokenMint}\``
  return ''
}

function hashApprovalPayload(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function requestWalletApproval(params: {
  wallet: { requireApproval: boolean; chain: 'ethereum' | 'solana' }
  approved: unknown
  approvalId: unknown
  category: ApprovalCategory
  action: string
  title: string
  description: string
  summary: string
  data: Record<string, unknown>
  context: { agentId?: string | null; sessionId?: string | null }
}): Promise<string | null> {
  void params
  return null
}

function buildEthereumTransaction(normalized: Record<string, unknown>): {
  transaction: Record<string, unknown>
  summaryParts: string[]
} {
  const explicitTx = parseRecordValue(normalized.transaction ?? normalized.transactionJson, 'transaction') || {}
  const transaction: Record<string, unknown> = { ...explicitTx }
  const summaryParts: string[] = []

  const contractAddress = trimString(normalized.contractAddress)
  const toAddress = trimString(normalized.toAddress ?? normalized.to)
  if (!transaction.to && (contractAddress || toAddress)) {
    transaction.to = contractAddress || toAddress
  }

  const data = trimString(normalized.data ?? normalized.calldata)
  if (data) transaction.data = data

  const valueAtomic = normalized.valueAtomic ?? normalized.valueWei
  if (valueAtomic !== undefined && valueAtomic !== null && valueAtomic !== '') {
    transaction.value = typeof valueAtomic === 'string' ? valueAtomic.trim() : valueAtomic
  }

  const abi = normalized.abi
  const functionName = trimString(normalized.functionName)
  if (abi !== undefined && functionName) {
    const args = parseFunctionArgsValue(normalized.args ?? normalized.functionArgs, 'args') || []
    const encoded = encodeEthereumContractCall(abi, functionName, args)
    transaction.data = encoded.data
    summaryParts.push(`contract call ${functionName}`)
    if (contractAddress) summaryParts.push(`contract ${contractAddress}`)
  }

  if (trimString(String(transaction.to || ''))) summaryParts.push(`to ${String(transaction.to)}`)
  if (typeof transaction.value === 'string' && transaction.value.trim()) {
    summaryParts.push(`value ${transaction.value.trim()} wei`)
  }
  if (typeof transaction.data === 'string' && transaction.data.trim()) {
    summaryParts.push(`data ${String(transaction.data).slice(0, 18)}...`)
  }

  return { transaction, summaryParts }
}

function buildSolanaTransactionSummary(normalized: Record<string, unknown>, cluster: SolanaCluster): string {
  const explicitTx = trimString(normalized.transactionBase64)
  const signedTx = trimString(normalized.signedTransactionBase64)
  const parts = [`cluster ${getSolanaClusterLabel(cluster)}`]
  if (signedTx) parts.push('signed transaction')
  else if (explicitTx) parts.push('unsigned transaction')
  return parts.join(', ')
}

function buildWalletApprovalResumeInput(approval: ApprovalRequest): Record<string, unknown> | null {
  const action = trimString(approval.data.action)
  const chain = trimString(approval.data.chain)
  const network = trimString(approval.data.network)
  if (!action || !chain) return null

  if (approval.category === 'wallet_transfer') {
    const toAddress = trimString(approval.data.toAddress)
    const amount = trimString(approval.data.amount)
    const memo = trimString(approval.data.memo)
    if (!toAddress || !amount) return null
    return {
      action: 'send',
      chain,
      toAddress,
      amount,
      ...(memo ? { memo } : {}),
    }
  }

  if (approval.category !== 'wallet_action') return null

  switch (action) {
    case 'send_transaction':
    case 'sign_transaction': {
      const transaction = isPlainRecord(approval.data.transaction) ? approval.data.transaction : null
      const signedTransaction = trimString(approval.data.signedTransaction)
      if (!transaction && !signedTransaction) return null
      return {
        action,
        chain,
        ...(network ? { network } : {}),
        ...(transaction ? { transaction } : {}),
        ...(signedTransaction ? { signedTransaction } : {}),
      }
    }
    case 'sign_typed_data': {
      const domain = isPlainRecord(approval.data.domain) ? approval.data.domain : null
      const types = isPlainRecord(approval.data.types) ? approval.data.types : null
      const value = isPlainRecord(approval.data.value) ? approval.data.value : null
      if (!domain || !types || !value) return null
      return {
        action,
        chain,
        ...(network ? { network } : {}),
        domain,
        types,
        value,
      }
    }
    case 'swap': {
      const sellToken = trimString(approval.data.sellToken)
      const buyToken = trimString(approval.data.buyToken)
      const amountAtomic = trimString(approval.data.amountAtomic)
      const recipient = trimString(approval.data.recipient)
      const slippageBps = trimString(approval.data.slippageBps)
      if (!sellToken || !buyToken || !amountAtomic) return null
      return {
        action,
        chain,
        ...(network ? { network } : {}),
        sellToken,
        buyToken,
        sellAmountAtomic: amountAtomic,
        ...(recipient ? { recipient } : {}),
        ...(slippageBps ? { slippageBps } : {}),
      }
    }
    default:
      return null
  }
}

async function executeWalletAction(args: unknown, context: { agentId?: string | null; sessionId?: string | null }) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const action = trimString(normalized.action) as WalletToolAction | ''
  const requestedChainExplicit = normalized.chain !== undefined || normalized.provider !== undefined
  const toAddress = trimString(normalized.toAddress ?? normalized.to)
  const amount = normalized.amount as string | number | undefined
  const amountLegacy = normalized.amountSol as number | undefined
  const memo = trimString(normalized.memo)
  const limit = typeof normalized.limit === 'number' ? normalized.limit : undefined
  const label = trimString(normalized.label) || undefined
  const agentId = context.agentId

  if (!agentId) return JSON.stringify({ error: 'No agent ID in context' })

  let requestedChain: 'ethereum' | 'solana'
  try {
    requestedChain = getWalletChainOrDefault(normalized.chain ?? normalized.provider, 'solana')
  } catch (err: unknown) {
    return JSON.stringify({ error: errorMessage(err) })
  }

  const wallets = getWalletsByAgentId(agentId)
  const defaultWallet = getWalletByAgentId(agentId)
  const requestedWallet = getWalletByAgentId(agentId, requestedChain)

  if (wallets.length === 0) {
    if (action === 'setup') {
      try {
        const created = createAgentWallet({ agentId, chain: requestedChain, label })
        return JSON.stringify({
          status: 'wallet_created',
          chain: created.chain,
          address: created.publicKey,
          symbol: getWalletAssetSymbol(created.chain),
          message: `Created a ${created.chain} wallet for this agent.`,
          actions: [
            { id: 'view-wallet', label: 'Open Wallets', href: '/wallets' },
            { id: 'view-explorer', label: 'View Address', href: getWalletExplorerUrl(created.chain, 'address', created.publicKey) },
          ],
        })
      } catch (err: unknown) {
        return JSON.stringify({ error: errorMessage(err) })
      }
    }

    return JSON.stringify({
      status: 'wallet_not_linked',
      message: 'No wallet linked to this agent yet.',
      setup: {
        tool: 'wallet_tool',
        action: 'setup',
        body: { chain: requestedChain },
      },
    })
  }

  if (action === 'setup' && requestedChainExplicit && !requestedWallet) {
    try {
      const created = createAgentWallet({ agentId, chain: requestedChain, label })
      return JSON.stringify({
        status: 'wallet_created',
        chain: created.chain,
        address: created.publicKey,
        symbol: getWalletAssetSymbol(created.chain),
        message: `Created a ${created.chain} wallet for this agent.`,
        actions: [
          { id: 'view-wallet', label: 'Open Wallets', href: '/wallets' },
          { id: 'view-explorer', label: 'View Address', href: getWalletExplorerUrl(created.chain, 'address', created.publicKey) },
        ],
      })
    } catch (err: unknown) {
      return JSON.stringify({ error: errorMessage(err) })
    }
  }

  const wallet = requestedChainExplicit ? requestedWallet : defaultWallet
  if (!wallet) {
    return JSON.stringify({
      status: 'wallet_not_linked',
      message: requestedChainExplicit
        ? `No ${requestedChain} wallet linked to this agent yet.`
        : 'No wallet linked to this agent yet.',
      setup: {
        tool: 'wallet_tool',
        action: 'setup',
        body: { chain: requestedChain },
      },
    })
  }

  try {
    switch (action) {
      case 'setup': {
        const activeWalletId = getAgentActiveWalletId(loadAgents()[agentId])
        return JSON.stringify({
          status: 'wallet_ready',
          chain: wallet.chain,
          address: wallet.publicKey,
          symbol: getWalletAssetSymbol(wallet.chain),
          isActive: activeWalletId === wallet.id,
          message: requestedChainExplicit
            ? `This agent already has a ${wallet.chain} wallet ready.`
            : `This agent has ${wallets.length} wallet${wallets.length === 1 ? '' : 's'} linked. The default wallet is ${wallet.chain}.`,
        })
      }
      case 'balance': {
        const portfolio = await getWalletPortfolioSnapshot(wallet)
        const assetLines = portfolio.assets
          .filter((asset) => BigInt(asset.balanceAtomic) > BigInt(0))
          .slice(0, 8)
          .map((asset) => `- \`${asset.balanceDisplay}\` on \`${asset.networkLabel}\`${asset.isNative ? '' : ` via \`${asset.symbol}\``}${describeWalletAssetIdentity(asset)}`)
          .join('\n')
        return JSON.stringify({
          kind: 'plugin-ui',
          text: `### Wallet Balance\n\n**Chain:** \`${wallet.chain}\`\n**Address:** \`${wallet.publicKey}\`\n**Primary Balance:** \`${portfolio.balanceDisplay}\`\n**Assets Detected:** \`${portfolio.summary.nonZeroAssets}\`\n${assetLines ? `\n${assetLines}` : '\nNo funded assets detected yet.'}`,
          actions: [
            { id: 'view-wallet', label: 'View Address', href: getWalletExplorerUrl(wallet.chain, 'address', wallet.publicKey) },
          ],
        })
      }
      case 'address':
        return JSON.stringify({
          address: wallet.publicKey,
          chain: wallet.chain,
          symbol: getWalletAssetSymbol(wallet.chain),
          explorerUrl: getWalletExplorerUrl(wallet.chain, 'address', wallet.publicKey),
        })
      case 'send': {
        const symbol = getWalletAssetSymbol(wallet.chain)
        const displayAmount = amount ?? amountLegacy
        if (!toAddress) return JSON.stringify({ error: 'toAddress is required for send' })
        if (displayAmount === undefined || displayAmount === null || String(displayAmount).trim() === '') {
          return JSON.stringify({ error: 'amount must be positive' })
        }
        if (!isValidWalletAddress(wallet.chain, toAddress)) return JSON.stringify({ error: `Invalid ${wallet.chain} address` })

        let amountAtomic = '0'
        let formattedAmount = ''
        try {
          amountAtomic = parseDisplayAmountToAtomic(displayAmount, wallet.chain === 'ethereum' ? 18 : 9)
          if (BigInt(amountAtomic) <= BigInt(0)) return JSON.stringify({ error: 'amount must be positive' })
          formattedAmount = formatWalletAmount(wallet.chain, amountAtomic, { minFractionDigits: 4, maxFractionDigits: 6 })
        } catch (err: unknown) {
          return JSON.stringify({ error: errorMessage(err) })
        }

        const perTxLimitAtomic = getWalletLimitAtomic(wallet, 'perTx')
        if (BigInt(amountAtomic) > BigInt(perTxLimitAtomic)) {
          return JSON.stringify({
            error: `Amount ${formattedAmount} ${symbol} exceeds limit of ${formatWalletAmount(wallet.chain, perTxLimitAtomic, { maxFractionDigits: 6 })} ${symbol}`,
          })
        }

        const approvalResponse = await requestWalletApproval({
          wallet,
          approved: normalized.approved,
          approvalId: normalized.approvalId,
          category: 'wallet_transfer',
          action,
          title: `Send ${formattedAmount} ${symbol}`,
          description: `Transfer to ${toAddress}. Memo: ${memo || 'none'}`,
          summary: `transfer ${formattedAmount} ${symbol} to ${toAddress}`,
          data: {
            toAddress,
            amount: formattedAmount,
            amountDisplay: `${formattedAmount} ${symbol}`,
            amountAtomic,
            assetSymbol: symbol,
            chain: wallet.chain,
            memo,
          },
          context,
        })
        if (approvalResponse) return approvalResponse

        const baseUrl = process.env.NEXTAUTH_URL || `http://localhost:${process.env.PORT || 3456}`
        const res = await fetch(`${baseUrl}/api/wallets/${wallet.id}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Access-Key': process.env.ACCESS_KEY || '' },
          body: JSON.stringify({ toAddress, amountAtomic, memo }),
        })
        const data = await res.json()

        if (data.signature) {
          return JSON.stringify({
            kind: 'plugin-ui',
            text: `### Transaction Sent!\n\n**Amount:** \`${formattedAmount} ${symbol}\`\n**To:** \`${toAddress}\`\n**Tx:** \`${data.signature.slice(0, 10)}...\``,
            actions: [
              { id: 'view-tx', label: 'View Transaction', href: getWalletExplorerUrl(wallet.chain, 'transaction', data.signature) },
            ],
          })
        }
        return JSON.stringify(data)
      }
      case 'transactions': {
        const allTxs = loadWalletTransactions() as Record<string, WalletTransaction>
        const walletTxs = Object.values(allTxs)
          .filter((tx) => tx.walletId === wallet.id)
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, limit ?? 5)

        const symbol = getWalletAssetSymbol(wallet.chain)
        const txLines = walletTxs
          .map((tx) => `- **${tx.type.toUpperCase()}**: ${formatWalletAmount(tx.chain, getWalletAtomicAmount(tx), { minFractionDigits: 4, maxFractionDigits: 6 })} ${symbol} (${tx.status})`)
          .join('\n')

        return JSON.stringify({
          kind: 'plugin-ui',
          text: `### Recent Transactions\n\n${txLines || 'No recent transactions found.'}`,
          actions: [
            { id: 'view-history', label: 'View Address', href: getWalletExplorerUrl(wallet.chain, 'address', wallet.publicKey) },
          ],
        })
      }
      case 'sign_message': {
        const network = wallet.chain === 'ethereum'
          ? getEvmNetworkConfig(normalized.network).label
          : getSolanaClusterLabel(normalized.network)
        const summary = `sign message on ${network}`
        const approvalResponse = await requestWalletApproval({
          wallet,
          approved: normalized.approved,
          approvalId: normalized.approvalId,
          category: 'wallet_action',
          action,
          title: `Wallet action: sign message`,
          description: `Sign a message with the ${wallet.chain} wallet on ${network}.`,
          summary,
          data: {
            network: wallet.chain === 'ethereum'
              ? getEvmNetworkConfig(normalized.network).id
              : normalizeSolanaCluster(normalized.network),
            messageDigest: hashApprovalPayload(JSON.stringify({
              message: typeof normalized.message === 'string' ? normalized.message : null,
              messageHex: typeof normalized.messageHex === 'string' ? normalized.messageHex : null,
              messageBase64: typeof normalized.messageBase64 === 'string' ? normalized.messageBase64 : null,
            })),
          },
          context,
        })
        if (approvalResponse) return approvalResponse

        if (wallet.chain === 'ethereum') {
          const result = await signEthereumMessage(wallet.encryptedPrivateKey, {
            message: typeof normalized.message === 'string' ? normalized.message : null,
            messageHex: typeof normalized.messageHex === 'string' ? normalized.messageHex : null,
            messageBase64: typeof normalized.messageBase64 === 'string' ? normalized.messageBase64 : null,
          })
          return JSON.stringify({
            status: 'signed',
            action,
            chain: wallet.chain,
            network: getEvmNetworkConfig(normalized.network).id,
            address: result.address,
            signature: result.signature,
          })
        }

        const result = await signSolanaMessage(wallet.encryptedPrivateKey, {
          message: typeof normalized.message === 'string' ? normalized.message : null,
          messageHex: typeof normalized.messageHex === 'string' ? normalized.messageHex : null,
          messageBase64: typeof normalized.messageBase64 === 'string' ? normalized.messageBase64 : null,
        })
        return JSON.stringify({
          status: 'signed',
          action,
          chain: wallet.chain,
          network: normalizeSolanaCluster(normalized.network),
          address: result.publicKey,
          signature: result.signature,
        })
      }
      case 'sign_typed_data': {
        if (wallet.chain !== 'ethereum') {
          return JSON.stringify({ error: 'sign_typed_data is only supported for Ethereum-compatible wallets' })
        }

        const typedData = parseRecordValue(normalized.typedData, 'typedData')
        const domain = parseRecordValue(normalized.domain, 'domain') || parseRecordValue(typedData?.domain, 'typedData.domain')
        const types = parseRecordValue(normalized.types, 'types') || parseRecordValue(typedData?.types, 'typedData.types')
        const value = parseRecordValue(normalized.value, 'value')
          || parseRecordValue(normalized.messageValue, 'messageValue')
          || parseRecordValue(typedData?.message, 'typedData.message')
        if (!domain || !types || !value) {
          return JSON.stringify({ error: 'domain, types, and value are required for sign_typed_data' })
        }

        const network = getEvmNetworkConfig(normalized.network).id
        const approvalResponse = await requestWalletApproval({
          wallet,
          approved: normalized.approved,
          approvalId: normalized.approvalId,
          category: 'wallet_action',
          action,
          title: 'Wallet action: sign typed data',
          description: `Sign typed data with the Ethereum wallet on ${getEvmNetworkConfig(network).label}.`,
          summary: `sign typed data on ${getEvmNetworkConfig(network).label}`,
          data: { network, domain, types, value },
          context,
        })
        if (approvalResponse) return approvalResponse

        const result = await signEthereumTypedData(wallet.encryptedPrivateKey, { domain, types, value })
        return JSON.stringify({
          status: 'signed',
          action,
          chain: wallet.chain,
          network,
          address: result.address,
          signature: result.signature,
        })
      }
      case 'call_contract': {
        if (wallet.chain !== 'ethereum') {
          return JSON.stringify({ error: 'call_contract is only supported for Ethereum-compatible wallets' })
        }
        const abi = normalized.abi
        const functionName = trimString(normalized.functionName)
        const contractAddress = trimString(normalized.contractAddress)
        if (!abi || !functionName || !contractAddress) {
          return JSON.stringify({ error: 'contractAddress, abi, and functionName are required for call_contract' })
        }
        const args = parseFunctionArgsValue(normalized.args ?? normalized.functionArgs, 'args') || []
        const result = await callEthereumContract(
          wallet.encryptedPrivateKey,
          {
            contractAddress,
            abi,
            functionName,
            args,
          },
          {
            network: trimString(normalized.network) || undefined,
            rpcUrl: trimString(normalized.rpcUrl) || undefined,
          },
        )
        return JSON.stringify({
          status: 'called',
          action,
          chain: wallet.chain,
          network: result.network.id,
          address: result.address,
          contractAddress,
          functionName,
          fragment: result.fragment,
          data: result.data,
          rawResult: result.rawResult,
          decoded: result.decoded,
          namedOutputs: result.namedOutputs,
        })
      }
      case 'encode_contract_call': {
        if (wallet.chain !== 'ethereum') {
          return JSON.stringify({ error: 'encode_contract_call is only supported for Ethereum-compatible wallets' })
        }
        const abi = normalized.abi
        const functionName = trimString(normalized.functionName)
        if (!abi || !functionName) return JSON.stringify({ error: 'abi and functionName are required for encode_contract_call' })
        const args = parseFunctionArgsValue(normalized.args ?? normalized.functionArgs, 'args') || []
        const encoded = encodeEthereumContractCall(abi, functionName, args)
        return JSON.stringify({
          status: 'encoded',
          action,
          chain: wallet.chain,
          functionName,
          fragment: encoded.fragment,
          data: encoded.data,
        })
      }
      case 'quote_swap': {
        if (wallet.chain !== 'ethereum') {
          return JSON.stringify({ error: 'quote_swap is only supported for Ethereum-compatible wallets' })
        }
        const network = getEvmNetworkConfig(normalized.network).id
        const sellToken = trimString(pickFirstDefined(normalized, ['sellToken', 'fromToken', 'inputToken', 'srcToken', 'tokenIn']))
        const buyToken = trimString(pickFirstDefined(normalized, ['buyToken', 'toToken', 'outputToken', 'destToken', 'tokenOut']))
        const sellAmountAtomic = pickFirstDefined(normalized, ['sellAmountAtomic', 'amountAtomic', 'srcAmountAtomic'])
        const sellAmountDisplay = pickFirstDefined(normalized, ['sellAmount', 'amount', 'sellAmountDisplay', 'srcAmount'])
        const recipient = pickFirstDefined(normalized, ['recipient', 'receiver', 'destReceiver'])
        const plan = await prepareEvmSwapPlan({
          wallet,
          network,
          sellToken,
          buyToken,
          sellAmountAtomic,
          sellAmountDisplay,
          slippageBps: pickFirstDefined(normalized, ['slippageBps', 'slippage', 'slippagePercent']),
          recipient,
          rpcUrl: trimString(normalized.rpcUrl) || undefined,
        })
        return JSON.stringify({
          status: 'quoted',
          action,
          chain: wallet.chain,
          network,
          provider: plan.provider,
          routeSummary: plan.routeSummary,
          sellToken: plan.sellToken,
          buyToken: plan.buyToken,
          sellAmountAtomic: plan.sellAmountAtomic,
          sellAmountDisplay: plan.sellAmountDisplay,
          estimatedBuyAmountAtomic: plan.buyAmountAtomic,
          estimatedBuyAmountDisplay: plan.buyAmountDisplay,
          slippageBps: plan.slippageBps,
          spenderAddress: plan.spenderAddress,
          approvalRequired: plan.approvalRequired,
          approvalTransaction: plan.approvalTransaction,
          swapTransaction: plan.swapTransaction,
          recipient: plan.recipient,
        })
      }
      case 'simulate_transaction': {
        if (wallet.chain === 'ethereum') {
          const network = getEvmNetworkConfig(normalized.network).id
          const { transaction, summaryParts } = buildEthereumTransaction(normalized)
          if (!transaction.to && !transaction.data) {
            return JSON.stringify({ error: 'transaction.to or contract calldata is required for simulate_transaction' })
          }
          const result = await simulateEthereumTransaction(wallet.encryptedPrivateKey, transaction, {
            network,
            rpcUrl: trimString(normalized.rpcUrl) || undefined,
          })
          return JSON.stringify({
            status: 'simulated',
            action,
            chain: wallet.chain,
            network: result.network.id,
            address: result.address,
            estimateGas: result.estimateGas,
            callResult: result.callResult,
            callError: result.callError,
          })
        }

        const cluster = normalizeSolanaCluster(normalized.network)
        const transactionBase64 = trimString(normalized.transactionBase64)
        if (!transactionBase64) return JSON.stringify({ error: 'transactionBase64 is required for Solana simulate_transaction' })
        const result = await simulateSolanaTransaction(wallet.encryptedPrivateKey, transactionBase64, {
          cluster,
          rpcUrl: trimString(normalized.rpcUrl) || undefined,
        })
        return JSON.stringify({
          status: 'simulated',
          action,
          chain: wallet.chain,
          network: cluster,
          address: result.publicKey,
          signatures: result.signatures,
          logs: result.logs,
          unitsConsumed: result.unitsConsumed,
          err: result.err,
          versioned: result.versioned,
        })
      }
      case 'sign_transaction': {
        if (wallet.chain === 'ethereum') {
          const network = getEvmNetworkConfig(normalized.network).id
          const { transaction, summaryParts } = buildEthereumTransaction(normalized)
          if (!transaction.to && !transaction.data) {
            return JSON.stringify({ error: 'transaction.to or contract calldata is required for sign_transaction' })
          }
          const approvalResponse = await requestWalletApproval({
            wallet,
            approved: normalized.approved,
            approvalId: normalized.approvalId,
            category: 'wallet_action',
            action,
            title: 'Wallet action: sign transaction',
            description: `Sign an Ethereum transaction on ${getEvmNetworkConfig(network).label}.`,
            summary: summaryParts.join(', ') || `sign transaction on ${getEvmNetworkConfig(network).label}`,
            data: { network, transaction },
            context,
          })
          if (approvalResponse) return approvalResponse

          const result = await signEthereumTransaction(wallet.encryptedPrivateKey, transaction, {
            network,
            rpcUrl: trimString(normalized.rpcUrl) || undefined,
          })
          return JSON.stringify({
            status: 'signed',
            action,
            chain: wallet.chain,
            network: result.network.id,
            address: result.address,
            signedTransaction: result.signedTransaction,
            transactionHash: result.transactionHash,
          })
        }

        const transactionBase64 = trimString(normalized.transactionBase64)
        if (!transactionBase64) return JSON.stringify({ error: 'transactionBase64 is required for Solana sign_transaction' })
        const cluster = normalizeSolanaCluster(normalized.network)
        const approvalResponse = await requestWalletApproval({
          wallet,
          approved: normalized.approved,
          approvalId: normalized.approvalId,
          category: 'wallet_action',
          action,
          title: 'Wallet action: sign transaction',
          description: `Sign a Solana transaction on ${getSolanaClusterLabel(cluster)}.`,
          summary: buildSolanaTransactionSummary(normalized, cluster),
          data: {
            network: cluster,
            transactionFingerprint: hashApprovalPayload(transactionBase64),
          },
          context,
        })
        if (approvalResponse) return approvalResponse

        const result = await signSolanaTransaction(wallet.encryptedPrivateKey, transactionBase64)
        return JSON.stringify({
          status: 'signed',
          action,
          chain: wallet.chain,
          network: cluster,
          address: result.publicKey,
          signatures: result.signatures,
          signedTransactionBase64: result.signedTransactionBase64,
          versioned: result.versioned,
        })
      }
      case 'swap': {
        if (wallet.chain !== 'ethereum') {
          return JSON.stringify({ error: 'swap is only supported for Ethereum-compatible wallets' })
        }
        const network = getEvmNetworkConfig(normalized.network).id
        const sellToken = trimString(pickFirstDefined(normalized, ['sellToken', 'fromToken', 'inputToken', 'srcToken', 'tokenIn']))
        const buyToken = trimString(pickFirstDefined(normalized, ['buyToken', 'toToken', 'outputToken', 'destToken', 'tokenOut']))
        const sellAmountAtomic = pickFirstDefined(normalized, ['sellAmountAtomic', 'amountAtomic', 'srcAmountAtomic'])
        const sellAmountDisplay = pickFirstDefined(normalized, ['sellAmount', 'amount', 'sellAmountDisplay', 'srcAmount'])
        const recipient = pickFirstDefined(normalized, ['recipient', 'receiver', 'destReceiver'])
        const slippageBps = pickFirstDefined(normalized, ['slippageBps', 'slippage', 'slippagePercent'])
        const waitForReceipt = normalized.waitForReceipt !== false
        const buildPlan = () => prepareEvmSwapPlan({
          wallet,
          network,
          sellToken,
          buyToken,
          sellAmountAtomic,
          sellAmountDisplay,
          slippageBps,
          recipient,
          rpcUrl: trimString(normalized.rpcUrl) || undefined,
        })
        let plan = await buildPlan()
        const title = `Wallet action: swap ${plan.sellAmountDisplay} to ${plan.buyToken.symbol}`
        const description = plan.approvalRequired
          ? `Execute a swap on ${plan.network.label}. This will send an exact token approval transaction to ${plan.spenderAddress} and then broadcast the swap transaction.`
          : `Execute a swap on ${plan.network.label} and broadcast the resulting transaction.`
        const summary = `swap ${plan.sellAmountDisplay} for about ${plan.buyAmountDisplay} on ${plan.network.label} via ${plan.provider}${plan.routeSummary ? ` (${plan.routeSummary})` : ''}`
        const approvalResponse = await requestWalletApproval({
          wallet,
          approved: normalized.approved,
          approvalId: normalized.approvalId,
          category: 'wallet_action',
          action,
          title,
          description,
          summary,
          data: {
            network,
            sellToken: plan.sellToken.address,
            buyToken: plan.buyToken.address,
            recipient: plan.recipient,
            amountAtomic: plan.sellAmountAtomic,
            amountDisplay: plan.sellAmountDisplay,
            estimatedBuyAmountAtomic: plan.buyAmountAtomic,
            estimatedBuyAmountDisplay: plan.buyAmountDisplay,
            slippageBps: String(plan.slippageBps),
            routeProvider: plan.provider,
            routeSummary: plan.routeSummary,
            spenderAddress: plan.spenderAddress || '',
          },
          context,
        })
        if (approvalResponse) return approvalResponse

        let approvalBroadcast: Awaited<ReturnType<typeof sendEthereumTransaction>> | null = null
        if (plan.approvalRequired && plan.approvalTransaction) {
          approvalBroadcast = await sendEthereumTransaction(
            wallet.encryptedPrivateKey,
            {
              transaction: plan.approvalTransaction,
              waitForReceipt: true,
            },
            {
              network,
              rpcUrl: trimString(normalized.rpcUrl) || undefined,
            },
          )
          clearWalletPortfolioCache(wallet.id)
        }

        const sendSwap = async (preparedPlan: typeof plan) => sendEthereumTransaction(
          wallet.encryptedPrivateKey,
          {
            transaction: preparedPlan.swapTransaction,
            waitForReceipt,
          },
          {
            network,
            rpcUrl: trimString(normalized.rpcUrl) || undefined,
          },
        )

        let swapResult: Awaited<ReturnType<typeof sendEthereumTransaction>>
        try {
          swapResult = await sendSwap(plan)
        } catch (err: unknown) {
          if (!isLikelyRetryableSwapError(err)) throw err
          plan = await buildPlan()
          swapResult = await sendSwap(plan)
        }

        clearWalletPortfolioCache(wallet.id)
        const txId = genId()
        const now = Date.now()
        const approvedBy = wallet.requireApproval ? (trimString(normalized.approvalId) ? 'user' : 'auto') : undefined
        const txRecord: WalletTransaction = {
          id: txId,
          walletId: wallet.id,
          agentId,
          chain: wallet.chain,
          type: 'swap',
          signature: swapResult.transactionHash,
          fromAddress: wallet.publicKey,
          toAddress: plan.recipient,
          amountAtomic: plan.sellAmountAtomic,
          feeAtomic: typeof swapResult.receipt?.fee === 'string' ? swapResult.receipt.fee : undefined,
          status: swapResult.receipt ? 'confirmed' : 'pending',
          memo: `Swapped ${plan.sellAmountDisplay} to approximately ${plan.buyAmountDisplay} on ${plan.network.label}`,
          approvedBy,
          tokenMint: plan.sellToken.isNative ? undefined : plan.sellToken.address,
          timestamp: now,
        }
        upsertWalletTransaction(txId, txRecord)

        return JSON.stringify({
          status: swapResult.receipt ? 'confirmed' : 'broadcast',
          action,
          chain: wallet.chain,
          network,
          provider: plan.provider,
          routeSummary: plan.routeSummary,
          sellToken: plan.sellToken,
          buyToken: plan.buyToken,
          sellAmountAtomic: plan.sellAmountAtomic,
          sellAmountDisplay: plan.sellAmountDisplay,
          estimatedBuyAmountAtomic: plan.buyAmountAtomic,
          estimatedBuyAmountDisplay: plan.buyAmountDisplay,
          approvalTransactionHash: approvalBroadcast?.transactionHash || undefined,
          transactionHash: swapResult.transactionHash,
          explorerUrl: swapResult.explorerUrl,
          receipt: swapResult.receipt,
          recipient: plan.recipient,
        })
      }
      case 'send_transaction': {
        if (wallet.chain === 'ethereum') {
          const network = getEvmNetworkConfig(normalized.network).id
          const signedTransaction = trimString(normalized.signedTransaction)
          const { transaction, summaryParts } = buildEthereumTransaction(normalized)
          if (!signedTransaction && !transaction.to && !transaction.data) {
            return JSON.stringify({ error: 'signedTransaction, transaction.to, or contract calldata is required for send_transaction' })
          }

          const approvalResponse = await requestWalletApproval({
            wallet,
            approved: normalized.approved,
            approvalId: normalized.approvalId,
            category: 'wallet_action',
          action,
          title: 'Wallet action: send transaction',
          description: `Broadcast an Ethereum transaction on ${getEvmNetworkConfig(network).label}.`,
          summary: summaryParts.join(', ') || `broadcast transaction on ${getEvmNetworkConfig(network).label}`,
          data: {
            network,
            transaction,
            signedTransactionFingerprint: signedTransaction ? hashApprovalPayload(signedTransaction) : '',
          },
          context,
        })
          if (approvalResponse) return approvalResponse

          const result = await sendEthereumTransaction(
            wallet.encryptedPrivateKey,
            {
              transaction: signedTransaction ? undefined : transaction,
              signedTransaction: signedTransaction || undefined,
              waitForReceipt: normalized.waitForReceipt === true,
            },
            {
              network,
              rpcUrl: trimString(normalized.rpcUrl) || undefined,
            },
          )
          clearWalletPortfolioCache(wallet.id)
          return JSON.stringify({
            status: 'broadcast',
            action,
            chain: wallet.chain,
            network: result.network.id,
            address: result.address,
            transactionHash: result.transactionHash,
            explorerUrl: result.explorerUrl,
            receipt: result.receipt,
          })
        }

        const cluster = normalizeSolanaCluster(normalized.network)
        const transactionBase64 = trimString(normalized.transactionBase64)
        const signedTransactionBase64 = trimString(normalized.signedTransactionBase64)
        if (!transactionBase64 && !signedTransactionBase64) {
          return JSON.stringify({ error: 'transactionBase64 or signedTransactionBase64 is required for Solana send_transaction' })
        }
        const approvalResponse = await requestWalletApproval({
          wallet,
          approved: normalized.approved,
          approvalId: normalized.approvalId,
          category: 'wallet_action',
          action,
          title: 'Wallet action: send transaction',
          description: `Broadcast a Solana transaction on ${getSolanaClusterLabel(cluster)}.`,
          summary: buildSolanaTransactionSummary(normalized, cluster),
          data: {
            network: cluster,
            transactionFingerprint: transactionBase64 ? hashApprovalPayload(transactionBase64) : '',
            signedTransactionFingerprint: signedTransactionBase64 ? hashApprovalPayload(signedTransactionBase64) : '',
          },
          context,
        })
        if (approvalResponse) return approvalResponse

        const result = await sendSolanaTransaction(
          wallet.encryptedPrivateKey,
          {
            transactionBase64: transactionBase64 || undefined,
            signedTransactionBase64: signedTransactionBase64 || undefined,
            waitForConfirmation: normalized.waitForConfirmation !== false,
          },
          {
            cluster,
            rpcUrl: trimString(normalized.rpcUrl) || undefined,
          },
        )
        clearWalletPortfolioCache(wallet.id)
        return JSON.stringify({
          status: 'broadcast',
          action,
          chain: wallet.chain,
          network: cluster,
          address: result.publicKey,
          signature: result.signature,
          explorerUrl: result.explorerUrl,
          versioned: result.versioned,
        })
      }
      default:
        return JSON.stringify({ error: `Unknown action: ${action}` })
    }
  } catch (err: unknown) {
    const msg = errorMessage(err)
    if (msg.includes('429') || msg.toLowerCase().includes('too many requests')) {
      console.warn('[wallet] Solana RPC rate-limited. Consider using a dedicated RPC endpoint (SOLANA_RPC_URL env var).')
    }
    return JSON.stringify({ error: msg })
  }
}

const WalletPlugin: Plugin = {
  name: 'Core Wallet',
  description: 'Manage an agent wallet, inspect assets, sign payloads, and execute generic onchain actions without venue-specific adapters.',
  hooks: {
    getAgentContext: async (ctx) => {
      const agentId = ctx.session.agentId
      if (!agentId) return null
      const wallets = getWalletsByAgentId(agentId)
      if (wallets.length === 0) return null

      const agent = loadAgents()[agentId]
      const activeWalletId = getAgentActiveWalletId(agent)
      const onlyWallet = wallets[0]
      const lines = [
        wallets.length === 1 ? '## Your Wallet' : '## Your Wallets',
        wallets.length === 1
          ? `You own a ${onlyWallet?.chain || 'wallet'} wallet. Speak about it in the first person ("my wallet", "my balance"). You can inspect assets, sign messages, sign transactions, and submit generic onchain actions directly.`
          : `You own ${wallets.length} wallets across multiple chains. Speak about them in the first person ("my wallet", "my Ethereum wallet", "my Solana wallet"). If you need a specific wallet, use the \`chain\` parameter on \`wallet_tool\` actions.`,
      ]

      for (const entry of wallets) {
        let portfolio = {
          balanceAtomic: '0',
          balanceDisplay: `0.0000 ${getWalletAssetSymbol(entry.chain)}`,
          assets: [] as Array<{ balanceAtomic: string; balanceDisplay?: string; networkLabel: string; symbol: string; isNative?: boolean }>,
          summary: { totalAssets: 0, nonZeroAssets: 0, tokenAssets: 0, networkCount: 0 },
        }
        try {
          portfolio = await getWalletPortfolioSnapshot(entry)
        } catch {
          // best-effort context only
        }
        const symbol = getWalletAssetSymbol(entry.chain)
        const perTxLimit = formatWalletAmount(entry.chain, getWalletLimitAtomic(entry, 'perTx'), { maxFractionDigits: 6 })
        const dailyLimit = formatWalletAmount(entry.chain, getWalletLimitAtomic(entry, 'daily'), { maxFractionDigits: 6 })
        const tokenPreview = portfolio.assets
          .filter((asset) => BigInt(asset.balanceAtomic) > BigInt(0) && asset.isNative !== true)
          .slice(0, 2)
          .map((asset) => `${asset.balanceDisplay || `${asset.symbol} on ${asset.networkLabel}`}${describeWalletAssetIdentity(asset)}`)
          .join(', ')
        lines.push(
          `- ${entry.chain === 'ethereum' ? 'Ethereum' : 'Solana'}${entry.id === activeWalletId ? ' (default)' : ''}: ${portfolio.balanceDisplay} at ${entry.publicKey}`,
          tokenPreview ? `  Tokens: ${tokenPreview}` : `  Assets detected: ${portfolio.summary.nonZeroAssets}`,
          `  Limits: ${perTxLimit} ${symbol}/tx, ${dailyLimit} ${symbol}/day${entry.requireApproval ? ', approval required' : ', auto-execution enabled'}`,
        )
      }

      lines.push('Use `wallet_tool` to inspect balances before external-service work. For API-native integrations, pair `wallet_tool` with `http_request`: fetch the docs or API payload first, then sign or broadcast only the specific request you can justify.')
      lines.push('For standard EVM token swaps on supported networks, prefer `wallet_tool` action `swap` or `quote_swap` instead of manually assembling router calldata from public APIs.')
      lines.push('When public quote or aggregator APIs are inconsistent, use read-only onchain primitives instead of endless venue-shopping. `wallet_tool` action `call_contract` can query allowances, quotes, and protocol state directly on EVM networks.')
      lines.push('Treat contract addresses, token mints, router addresses, and spender addresses returned by wallet or HTTP tools as authoritative inputs. Do not invent replacements unless a later tool result proves the earlier value is wrong.')
      lines.push('For EVM work, set `network` to `ethereum`, `arbitrum`, or `base`. For Solana work, set `network` to `mainnet-beta`, `devnet`, or `testnet`.')
      return lines.join('\n')
    },
    getCapabilityDescription: () => 'I can use my wallets through `wallet_tool` for setup, balance checks, address inspection, native transfers, read-only contract calls, message signing, typed-data signing, calldata encoding, generic EVM token swap quotes/execution, transaction simulation, and raw transaction broadcast.',
    getOperatingGuidance: () => [
      'Use `wallet_tool` to inspect balances and select the right wallet before exploring an external service or trading venue.',
      'For a standard EVM DEX trade on Ethereum, Arbitrum, or Base, prefer `wallet_tool` action `swap` before trying to invent router calldata yourself.',
      'Use `wallet_tool` action `quote_swap` when you need a read-only preview of the spender, allowance requirement, route, and executable swap transaction.',
      'Pair `wallet_tool` with `http_request` for API-native exchange and dApp workflows: discover the docs or payload first, then sign only the exact message or transaction required.',
      'Use the browser only for rendered UI or interactive page steps after the required wallet action is already understood.',
      'If multiple public APIs fail, switch to direct read-only contract calls with `wallet_tool` action `call_contract` instead of continuing to shop for venues.',
      'Treat token addresses, token mints, router addresses, spender addresses, and network identifiers returned by tools as authoritative unless newer tool evidence proves they changed.',
      'When the next step is a signature or transaction, call the real `wallet_tool` action instead of describing the action only in prose.',
      'Pass `chain: "ethereum"` or `chain: "solana"` explicitly whenever the task depends on a specific wallet.',
      'For EVM actions, also pass `network: "ethereum"`, `"arbitrum"`, or `"base"` when the venue or asset lives on a specific network.',
      'Treat `wallet_tool` as a server-side wallet capability. It does not inject a browser wallet extension or click wallet-connect/signature prompts inside third-party UIs.',
    ],
    getApprovalGuidance: ({ approval, phase, approved }) => {
      const category = approval.category
      if (category !== 'wallet_action' && category !== 'wallet_transfer') return null

      const resumeInput = buildWalletApprovalResumeInput(approval)
      if (phase === 'request') {
        return [
          'When this approval is granted, continue by calling `wallet_tool` for the exact approved action. Do not ask for approval again in prose.',
          'Do not change the approved amount, route, spender, destination, contract, or network unless a later tool result proves the approved action cannot execute as approved.',
        ]
      }

      if (phase === 'connector_reminder') {
        return 'Approving this lets the agent resume the exact blocked wallet action automatically.'
      }

      if (approved !== true) {
        return 'Do not retry the rejected wallet action. Inspect state again and request a fresh approval only for a materially different exact action justified by tool evidence.'
      }

      const lines = [
        'Resume immediately with `wallet_tool` using the exact approved action and this approvalId.',
        'Do not re-quote, re-route, or browse for alternatives before attempting the approved wallet action once.',
      ]
      if (resumeInput) {
        lines.push(`Exact tool input: ${JSON.stringify({ ...resumeInput, approvalId: approval.id })}`)
      } else {
        lines.push('Use the `Approved payload` fields above as the exact wallet action inputs and add the approvalId.')
      }
      return lines
    },
  } as PluginHooks,
  ui: {
    sidebarItems: [
      {
        id: 'wallet-dashboard',
        label: 'Wallet',
        href: '/wallets',
        position: 'top',
      },
    ],
    headerWidgets: [
      {
        id: 'wallet-status',
        label: 'Wallet',
      },
    ],
  },
  tools: [
    {
      name: 'wallet_tool',
      description: 'Manage your own crypto wallet, including setup, balances, read-only contract calls, signatures, generic EVM swap execution, transaction simulation, and generic onchain execution.',
      planning: {
        capabilities: [TOOL_CAPABILITY.walletInspect, TOOL_CAPABILITY.walletExecute],
        disciplineGuidance: [
          'For `wallet_tool`, inspect balances or addresses before attempting an exchange, dApp, or onchain workflow.',
          'Pass `{"chain":"ethereum"}` or `{"chain":"solana"}` explicitly whenever the task depends on a specific wallet.',
          'For a standard EVM token trade on Ethereum, Arbitrum, or Base, prefer `{"action":"swap",...}` or `{"action":"quote_swap",...}` instead of manually assembling router calldata.',
          'For API-native workflows, fetch the docs or request payload first, then use `wallet_tool` only for the exact signature, simulation, or broadcast step.',
          'If quote or assembly APIs keep failing, stop venue-shopping and use `wallet_tool` action `call_contract` for direct read-only onchain state or quote reads.',
          'Treat `wallet_tool` as a server-side wallet capability. It does not inject a browser wallet extension or complete third-party wallet-connect prompts for you.',
        ],
        requestMatchers: [
          {
            capability: TOOL_CAPABILITY.walletInspect,
            patterns: [
              'wallet',
              'balance',
              'address',
              'fund',
              'transfer',
              'send',
              'deposit',
              'withdraw',
              'swap',
              'bridge',
              'onchain',
              'token',
              'gas',
              'usdc',
              'eth',
              'sol',
              'solana',
              'ethereum',
              'arbitrum',
              'base',
              'wallet connect',
              'walletconnect',
              'dex',
              'erc-20',
              'spl',
              'trade on',
              'quote swap',
            ],
          },
          {
            capability: TOOL_CAPABILITY.walletExecute,
            patterns: [
              'swap',
              'trade',
              'buy token',
              'sell token',
              'sign message',
              'sign typed data',
              'signature',
              'typed data',
              'eip-712',
              'sign transaction',
              'send transaction',
              'simulate transaction',
              'broadcast transaction',
          'contract call',
          'call contract',
          'read contract',
              'calldata',
              'approve token',
              'raw transaction',
            ],
          },
        ],
      },
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...WALLET_TOOL_ACTIONS] },
          chain: { type: 'string', enum: ['solana', 'ethereum'], description: 'Selects or creates the wallet on this chain.' },
          provider: { type: 'string', description: 'Alias for chain or wallet ecosystem, for example "ethereum" or "evm".' },
          network: { type: 'string', description: 'Execution network or cluster. EVM: ethereum/arbitrum/base. Solana: mainnet-beta/devnet/testnet.' },
          rpcUrl: { type: 'string', description: 'Optional RPC override for the selected network.' },
          label: { type: 'string' },
          toAddress: { type: 'string' },
          contractAddress: { type: 'string' },
          amount: { type: 'string', description: 'Native asset amount in display units, such as SOL or ETH.' },
          amountSol: { type: 'number' },
          memo: { type: 'string' },
          limit: { type: 'number' },
          message: { type: 'string' },
          messageHex: { type: 'string' },
          messageBase64: { type: 'string' },
          abi: { type: 'string', description: 'ABI JSON array or a single ABI fragment string.' },
          functionName: { type: 'string' },
          args: { type: 'string', description: 'JSON array of function arguments, or a JSON object keyed by ABI input names.' },
          sellToken: { type: 'string', description: 'For EVM swaps: token to sell, as a symbol like USDC/ETH or a token contract address.' },
          buyToken: { type: 'string', description: 'For EVM swaps: token to buy, as a symbol like ETH/WETH/USDC or a token contract address.' },
          sellAmount: { type: 'string', description: 'For EVM swaps: amount to sell in display units.' },
          sellAmountAtomic: { type: 'string', description: 'For EVM swaps: amount to sell in atomic units.' },
          recipient: { type: 'string', description: 'Optional swap recipient. Defaults to the wallet address.' },
          slippageBps: { type: 'string', description: 'Optional max slippage in basis points. Also accepts simple percentage-like inputs such as 1 for 1%.' },
          data: { type: 'string' },
          valueAtomic: { type: 'string', description: 'Native value in atomic units such as wei or lamports.' },
          typedData: { type: 'string', description: 'Typed-data JSON object.' },
          domain: { type: 'string', description: 'Typed-data domain JSON object.' },
          types: { type: 'string', description: 'Typed-data types JSON object.' },
          value: { type: 'string', description: 'Typed-data value JSON object.' },
          transaction: { type: 'string', description: 'Transaction JSON object.' },
          transactionBase64: { type: 'string' },
          signedTransaction: { type: 'string' },
          signedTransactionBase64: { type: 'string' },
          waitForReceipt: { type: 'boolean' },
          waitForConfirmation: { type: 'boolean' },
          approvalId: { type: 'string', description: 'The approval request id that was manually approved by the user for this exact wallet action.' },
          approved: { type: 'boolean', description: 'Set to true only after the user has manually approved the requested wallet action.' },
        },
        required: ['action'],
      },
      execute: async (args, context) => executeWalletAction(args, { agentId: context.session.agentId, sessionId: context.session.id }),
    },
  ],
}

getPluginManager().registerBuiltin('wallet', WalletPlugin)

export function buildWalletTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('wallet')) return []
  return [
    tool(
      async (args) => executeWalletAction(args, { agentId: bctx.ctx?.agentId, sessionId: bctx.ctx?.sessionId }),
      {
        name: 'wallet_tool',
        description: WalletPlugin.tools![0].description,
        schema: z.object({
          action: z.enum(WALLET_TOOL_ACTIONS),
          chain: z.enum(['solana', 'ethereum']).optional().describe('Choose a specific wallet chain when the agent has multiple wallets.'),
          provider: z.string().optional(),
          network: z.string().optional(),
          rpcUrl: z.string().optional(),
          label: z.string().optional(),
          toAddress: z.string().optional(),
          contractAddress: z.string().optional(),
          amount: z.string().optional(),
          amountSol: z.number().optional(),
          memo: z.string().optional(),
          limit: z.number().optional(),
          message: z.string().optional(),
          messageHex: z.string().optional(),
          messageBase64: z.string().optional(),
          abi: z.any().optional(),
          functionName: z.string().optional(),
          args: z.any().optional(),
          sellToken: z.string().optional(),
          buyToken: z.string().optional(),
          sellAmount: z.string().optional(),
          sellAmountAtomic: z.union([z.string(), z.number()]).optional(),
          recipient: z.string().optional(),
          slippageBps: z.union([z.string(), z.number()]).optional(),
          data: z.string().optional(),
          valueAtomic: z.union([z.string(), z.number()]).optional(),
          typedData: z.any().optional(),
          domain: z.any().optional(),
          types: z.any().optional(),
          value: z.any().optional(),
          transaction: z.any().optional(),
          transactionBase64: z.string().optional(),
          signedTransaction: z.string().optional(),
          signedTransactionBase64: z.string().optional(),
          waitForReceipt: z.boolean().optional(),
          waitForConfirmation: z.boolean().optional(),
          approvalId: z.string().optional(),
          approved: z.boolean().optional(),
        }),
      },
    ),
  ]
}
