import type { ApprovalCategory, ApprovalRequest } from '@/types'

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeScalar(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return ''
    if (/^0x[0-9a-f]+$/i.test(trimmed)) return trimmed.toLowerCase()
    return trimmed
  }
  return value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue)
  if (!isPlainRecord(value)) return normalizeScalar(value)
  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const normalized = canonicalizeValue(value[key])
      if (normalized !== undefined) acc[key] = normalized
      return acc
    }, {})
}

function canonicalizeEthereumTransaction(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value)) return null
  const tx = value
  const comparable: Record<string, unknown> = {}
  const to = trimString(tx.to)
  const data = trimString(tx.data)
  const valueAtomic = tx.value
  const type = normalizeScalar(tx.type)
  const chainId = normalizeScalar(tx.chainId)

  if (to) comparable.to = /^0x[0-9a-f]+$/i.test(to) ? to.toLowerCase() : to
  if (data) comparable.data = /^0x[0-9a-f]+$/i.test(data) ? data.toLowerCase() : data
  if (valueAtomic !== undefined && valueAtomic !== null && valueAtomic !== '') comparable.value = normalizeScalar(valueAtomic)
  if (type !== null && type !== undefined && type !== '') comparable.type = type
  if (chainId !== null && chainId !== undefined && chainId !== '') comparable.chainId = chainId

  return Object.keys(comparable).length > 0 ? comparable : null
}

function comparableWalletActionPayload(data: Record<string, unknown>): Record<string, unknown> {
  const action = trimString(data.action)
  const chain = trimString(data.chain)
  const network = trimString(data.network)
  const payload: Record<string, unknown> = {
    action,
    chain,
    network,
  }

  const transaction = canonicalizeEthereumTransaction(data.transaction)
  if (transaction) payload.transaction = transaction

  const signedTransactionFingerprint = trimString(data.signedTransactionFingerprint)
  if (signedTransactionFingerprint) payload.signedTransactionFingerprint = signedTransactionFingerprint

  const transactionFingerprint = trimString(data.transactionFingerprint)
  if (transactionFingerprint) payload.transactionFingerprint = transactionFingerprint

  const messageDigest = trimString(data.messageDigest)
  if (messageDigest) payload.messageDigest = messageDigest

  const domain = canonicalizeValue(data.domain)
  if (domain && typeof domain === 'object') payload.domain = domain

  const types = canonicalizeValue(data.types)
  if (types && typeof types === 'object') payload.types = types

  const value = canonicalizeValue(data.value)
  if (value && typeof value === 'object') payload.value = value

  const toAddress = trimString(data.toAddress)
  if (toAddress) payload.toAddress = /^0x[0-9a-f]+$/i.test(toAddress) ? toAddress.toLowerCase() : toAddress

  const amountAtomic = normalizeScalar(data.amountAtomic)
  if (amountAtomic !== null && amountAtomic !== undefined && amountAtomic !== '') payload.amountAtomic = amountAtomic

  const sellToken = trimString(data.sellToken)
  if (sellToken) payload.sellToken = /^0x[0-9a-f]+$/i.test(sellToken) ? sellToken.toLowerCase() : sellToken

  const buyToken = trimString(data.buyToken)
  if (buyToken) payload.buyToken = /^0x[0-9a-f]+$/i.test(buyToken) ? buyToken.toLowerCase() : buyToken

  const recipient = trimString(data.recipient)
  if (recipient) payload.recipient = /^0x[0-9a-f]+$/i.test(recipient) ? recipient.toLowerCase() : recipient

  const routeProvider = trimString(data.routeProvider)
  if (routeProvider) payload.routeProvider = routeProvider

  const slippageBps = normalizeScalar(data.slippageBps)
  if (slippageBps !== null && slippageBps !== undefined && slippageBps !== '') payload.slippageBps = slippageBps

  return payload
}

export function buildApprovalComparablePayload(
  category: ApprovalCategory,
  data: Record<string, unknown>,
): Record<string, unknown> | null {
  switch (category) {
    case 'tool_access': {
      const targetId = trimString(data.toolId) || trimString(data.pluginId)
      return targetId ? { targetId } : null
    }
    case 'plugin_scaffold':
      return {
        filename: trimString(data.filename),
        code: trimString(data.code),
      }
    case 'plugin_install':
      return {
        url: trimString(data.url),
        pluginId: trimString(data.pluginId),
        filename: trimString(data.filename),
      }
    case 'wallet_transfer': {
      const toAddress = trimString(data.toAddress)
      return {
        chain: trimString(data.chain),
        toAddress: /^0x[0-9a-f]+$/i.test(toAddress) ? toAddress.toLowerCase() : toAddress,
        amountAtomic: normalizeScalar(data.amountAtomic),
        memo: trimString(data.memo),
      }
    }
    case 'wallet_action':
      return comparableWalletActionPayload(data)
    case 'human_loop':
      return {
        question: trimString(data.question),
        prompt: trimString(data.prompt),
        correlationId: trimString(data.correlationId),
      }
    case 'connector_sender':
      return {
        connectorId: trimString(data.connectorId),
        senderId: trimString(data.senderId),
        channelId: trimString(data.channelId),
      }
    case 'task_tool':
      return {
        toolName: trimString(data.toolName),
        args: canonicalizeValue(data.args),
      }
    default:
      return canonicalizeValue(data) as Record<string, unknown>
  }
}

export function buildApprovalMatchKey(input: {
  category: ApprovalCategory
  agentId?: string | null
  sessionId?: string | null
  taskId?: string | null
  data: Record<string, unknown>
}): string | null {
  const comparable = buildApprovalComparablePayload(input.category, input.data)
  if (!comparable) return null
  const scope = (() => {
    switch (input.category) {
      case 'tool_access':
      case 'connector_sender':
        return {
          agentId: trimString(input.agentId) || null,
          sessionId: trimString(input.agentId) ? null : (trimString(input.sessionId) || null),
          taskId: null,
        }
      default:
        return {
          agentId: trimString(input.agentId) || null,
          sessionId: trimString(input.sessionId) || null,
          taskId: trimString(input.taskId) || null,
        }
    }
  })()
  return JSON.stringify({
    category: input.category,
    ...scope,
    data: comparable,
  })
}

export function buildApprovalMatchKeyFromRequest(request: ApprovalRequest): string | null {
  return buildApprovalMatchKey({
    category: request.category,
    agentId: request.agentId,
    sessionId: request.sessionId,
    taskId: request.taskId,
    data: request.data,
  })
}
