import {
  JsonRpcProvider,
  Interface,
  ParamType,
  Result,
  Wallet,
  getBytes,
  getAddress,
  isAddress,
  keccak256,
  type JsonFragment,
  type TransactionRequest,
  type TypedDataDomain,
  type TypedDataField,
} from 'ethers'

import { decryptKey, encryptKey } from './storage'
import { errorMessage } from '@/lib/shared-utils'

export type EvmNetworkId = 'ethereum' | 'arbitrum' | 'base'

export interface EvmNetworkConfig {
  id: EvmNetworkId
  label: string
  chainId: number
  rpcUrl: string
  addressExplorerBaseUrl: string
  transactionExplorerBaseUrl: string
}

export interface EthereumExecutionOptions {
  network?: EvmNetworkId | string | null
  rpcUrl?: string | null
}

export interface EthereumMessageInput {
  message?: string | null
  messageHex?: string | null
  messageBase64?: string | null
}

function serializeEvmValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map((entry) => serializeEvmValue(entry))
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`
  if (value && typeof value === 'object') {
    if (value instanceof Result) {
      return Array.from(value).map((entry) => serializeEvmValue(entry))
    }
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (/^\d+$/.test(key)) continue
      out[key] = serializeEvmValue(entry)
    }
    return out
  }
  return value
}

const DEFAULT_RPC_URL = process.env.ETHEREUM_RPC_URL || process.env.EVM_RPC_URL || 'https://ethereum-rpc.publicnode.com'
const DEFAULT_EVM_RPC_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.EVM_RPC_TIMEOUT_MS || '20000', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 20_000
  return parsed
})()

const EVM_NETWORKS: Record<EvmNetworkId, EvmNetworkConfig> = {
  ethereum: {
    id: 'ethereum',
    label: 'Ethereum',
    chainId: 1,
    rpcUrl: process.env.ETHEREUM_RPC_URL || process.env.EVM_RPC_URL || 'https://ethereum-rpc.publicnode.com',
    addressExplorerBaseUrl: 'https://etherscan.io/address/',
    transactionExplorerBaseUrl: 'https://etherscan.io/tx/',
  },
  arbitrum: {
    id: 'arbitrum',
    label: 'Arbitrum',
    chainId: 42161,
    rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arbitrum-one-rpc.publicnode.com',
    addressExplorerBaseUrl: 'https://arbiscan.io/address/',
    transactionExplorerBaseUrl: 'https://arbiscan.io/tx/',
  },
  base: {
    id: 'base',
    label: 'Base',
    chainId: 8453,
    rpcUrl: process.env.BASE_RPC_URL || 'https://base-rpc.publicnode.com',
    addressExplorerBaseUrl: 'https://basescan.org/address/',
    transactionExplorerBaseUrl: 'https://basescan.org/tx/',
  },
}

function normalizeHexData(value: string, fieldName: string): string {
  const trimmed = value.trim()
  if (!/^0x[0-9a-fA-F]*$/.test(trimmed)) {
    throw new Error(`${fieldName} must be a 0x-prefixed hex string`)
  }
  return trimmed
}

function parseBigIntField(value: unknown, fieldName: string): bigint | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    if (/^\d+$/.test(trimmed)) return BigInt(trimmed)
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return BigInt(trimmed)
  }
  throw new Error(`${fieldName} must be an integer or hex quantity`)
}

function parseNumberField(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10)
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return Number(BigInt(trimmed))
  }
  throw new Error(`${fieldName} must be an integer`)
}

function normalizeAddressInput(value: string, fieldName: string): string {
  const trimmed = value.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new Error(`${fieldName} must be a 20-byte hex address`)
  }
  return getAddress(trimmed.toLowerCase())
}

function normalizeAbiArgument(param: ParamType, value: unknown, fieldName: string): unknown {
  if (param.baseType === 'address') {
    if (typeof value !== 'string') throw new Error(`${fieldName} must be an address string`)
    return normalizeAddressInput(value, fieldName)
  }
  if (param.baseType === 'array') {
    if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`)
    return value.map((entry, index) => normalizeAbiArgument(param.arrayChildren!, entry, `${fieldName}[${index}]`))
  }
  if (param.baseType === 'tuple') {
    const components = param.components ?? []
    if (Array.isArray(value)) {
      return components.map((component, index) => normalizeAbiArgument(component, value[index], `${fieldName}[${index}]`))
    }
    if (!value || typeof value !== 'object') throw new Error(`${fieldName} must be an object or array for tuple input`)
    return components.map((component, index) => {
      const record = value as Record<string, unknown>
      const componentValue = component.name && component.name in record
        ? record[component.name]
        : record[String(index)]
      return normalizeAbiArgument(component, componentValue, `${fieldName}.${component.name || index}`)
    })
  }
  return value
}

function normalizeFunctionArgs(
  fragment: NonNullable<ReturnType<Interface['getFunction']>>,
  args: unknown[] | Record<string, unknown>,
  functionName: string,
): unknown[] {
  const source = Array.isArray(args) ? args : args && typeof args === 'object' ? args : []
  if (!Array.isArray(source) && fragment.inputs.length === 1 && fragment.inputs[0].baseType === 'tuple') {
    const tupleInput = fragment.inputs[0]
    const hasNamedWrapper = tupleInput.name && tupleInput.name in source
    const hasIndexWrapper = '0' in source
    if (!hasNamedWrapper && !hasIndexWrapper) {
      return [normalizeAbiArgument(tupleInput, source, `${functionName}.args[${tupleInput.name || 0}]`)]
    }
  }
  return fragment.inputs.map((input, index) => {
    const rawValue = Array.isArray(source)
      ? source[index]
      : input.name && input.name in source
        ? source[input.name]
        : source[String(index)]
    return normalizeAbiArgument(input, rawValue, `${functionName}.args[${input.name || index}]`)
  })
}

function normalizeMessageInput(input: EthereumMessageInput): string | Uint8Array {
  if (typeof input.messageHex === 'string' && input.messageHex.trim()) {
    return getBytes(normalizeHexData(input.messageHex, 'messageHex'))
  }
  if (typeof input.messageBase64 === 'string' && input.messageBase64.trim()) {
    return Uint8Array.from(Buffer.from(input.messageBase64.trim(), 'base64'))
  }
  if (typeof input.message === 'string') return input.message
  throw new Error('message, messageHex, or messageBase64 is required')
}

function normalizeTypedDataDomain(domain: Record<string, unknown>): TypedDataDomain {
  const normalized: TypedDataDomain = { ...domain }
  if (domain.chainId !== undefined) {
    normalized.chainId = parseBigIntField(domain.chainId, 'typed data domain.chainId')
  }
  return normalized
}

function normalizeTypedDataTypes(types: Record<string, unknown>): Record<string, TypedDataField[]> {
  const out: Record<string, TypedDataField[]> = {}
  for (const [key, value] of Object.entries(types)) {
    if (key === 'EIP712Domain') continue
    if (!Array.isArray(value)) throw new Error(`typed data types.${key} must be an array`)
    out[key] = value.map((entry) => {
      if (!entry || typeof entry !== 'object') throw new Error(`typed data types.${key} entries must be objects`)
      const field = entry as Record<string, unknown>
      if (typeof field.name !== 'string' || typeof field.type !== 'string') {
        throw new Error(`typed data types.${key} entries require name and type`)
      }
      return { name: field.name, type: field.type }
    })
  }
  return out
}

function normalizeAbiInput(abi: unknown): ReadonlyArray<string | JsonFragment> {
  if (Array.isArray(abi)) return abi as ReadonlyArray<string | JsonFragment>
  if (typeof abi === 'string') {
    const trimmed = abi.trim()
    if (!trimmed) throw new Error('abi is required')
    if (trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed)
      if (!Array.isArray(parsed)) throw new Error('abi JSON must be an array')
      return parsed as ReadonlyArray<string | JsonFragment>
    }
    return [trimmed]
  }
  throw new Error('abi must be an array or JSON string')
}

function normalizeTransactionRequest(tx: Record<string, unknown>): TransactionRequest {
  const normalized: TransactionRequest = {}
  if (tx.to !== undefined && tx.to !== null && tx.to !== '') normalized.to = normalizeAddressInput(String(tx.to), 'transaction.to')
  if (tx.data !== undefined && tx.data !== null && tx.data !== '') normalized.data = normalizeHexData(String(tx.data), 'transaction.data')
  if (tx.value !== undefined) normalized.value = parseBigIntField(tx.value, 'transaction.value')
  if (tx.nonce !== undefined) normalized.nonce = parseNumberField(tx.nonce, 'transaction.nonce')
  if (tx.chainId !== undefined) normalized.chainId = parseNumberField(tx.chainId, 'transaction.chainId')
  if (tx.type !== undefined) normalized.type = parseNumberField(tx.type, 'transaction.type')
  if (tx.gasLimit !== undefined) normalized.gasLimit = parseBigIntField(tx.gasLimit, 'transaction.gasLimit')
  if (tx.gasPrice !== undefined) normalized.gasPrice = parseBigIntField(tx.gasPrice, 'transaction.gasPrice')
  if (tx.maxFeePerGas !== undefined) normalized.maxFeePerGas = parseBigIntField(tx.maxFeePerGas, 'transaction.maxFeePerGas')
  if (tx.maxPriorityFeePerGas !== undefined) normalized.maxPriorityFeePerGas = parseBigIntField(tx.maxPriorityFeePerGas, 'transaction.maxPriorityFeePerGas')
  if (tx.accessList !== undefined) normalized.accessList = tx.accessList as TransactionRequest['accessList']
  return normalized
}

async function withEthereumRpcTimeout<T>(promise: Promise<T>, label: string, timeoutMs = DEFAULT_EVM_RPC_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function resolveWalletAndTransaction(
  encryptedPrivateKey: string,
  tx: Record<string, unknown>,
  options?: EthereumExecutionOptions,
): Promise<{ provider: JsonRpcProvider; wallet: Wallet; txRequest: TransactionRequest; network: EvmNetworkConfig }> {
  const network = getEvmNetworkConfig(options?.network)
  const provider = getProviderForNetwork(options?.network, options?.rpcUrl)
  const wallet = getWalletFromEncrypted(encryptedPrivateKey).connect(provider)
  const fromAddress = typeof tx.from === 'string' ? tx.from.trim() : ''
  if (fromAddress && fromAddress.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(`transaction.from does not match wallet address ${wallet.address}`)
  }
  const txRequest = normalizeTransactionRequest(tx)
  if (txRequest.chainId == null) txRequest.chainId = network.chainId
  const populated = await withEthereumRpcTimeout(
    wallet.populateTransaction(txRequest),
    `populate transaction on ${network.label}`,
  )
  return { provider, wallet, txRequest: populated, network }
}

export function generateEthereumWallet(): { publicKey: string; encryptedPrivateKey: string } {
  const wallet = Wallet.createRandom()
  return {
    publicKey: wallet.address,
    encryptedPrivateKey: encryptKey(wallet.privateKey),
  }
}

export function getWalletFromEncrypted(encryptedPrivateKey: string): Wallet {
  return new Wallet(decryptKey(encryptedPrivateKey))
}

export function normalizeEvmNetwork(value: unknown, fallback: EvmNetworkId = 'ethereum'): EvmNetworkId {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return fallback
  if (normalized === 'ethereum' || normalized === 'eth' || normalized === 'mainnet') return 'ethereum'
  if (normalized === 'arbitrum' || normalized === 'arb' || normalized === 'arbitrum-one') return 'arbitrum'
  if (normalized === 'base') return 'base'
  throw new Error(`Unsupported EVM network: ${String(value)}`)
}

export function getEvmNetworkConfig(value?: unknown): EvmNetworkConfig {
  return EVM_NETWORKS[normalizeEvmNetwork(value)]
}

export function listEvmNetworkConfigs(): EvmNetworkConfig[] {
  return Object.values(EVM_NETWORKS)
}

export function getEvmExplorerUrl(network: EvmNetworkId | string | null | undefined, kind: 'address' | 'transaction', value: string): string {
  const config = getEvmNetworkConfig(network)
  return `${kind === 'address' ? config.addressExplorerBaseUrl : config.transactionExplorerBaseUrl}${value}`
}

export function getProvider(rpcUrl?: string): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl || DEFAULT_RPC_URL)
}

export function getProviderForNetwork(network?: EvmNetworkId | string | null, rpcUrl?: string | null): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl || getEvmNetworkConfig(network).rpcUrl)
}

export async function getBalance(address: string, rpcUrl?: string): Promise<bigint> {
  return withEthereumRpcTimeout(getProvider(rpcUrl).getBalance(address), 'get balance')
}

export async function sendEth(
  encryptedPrivateKey: string,
  toAddress: string,
  amountWei: string,
  rpcUrl?: string,
): Promise<{ signature: string; fee?: string }> {
  const provider = getProvider(rpcUrl)
  const wallet = getWalletFromEncrypted(encryptedPrivateKey).connect(provider)
  const tx = await withEthereumRpcTimeout(wallet.sendTransaction({
    to: toAddress,
    value: BigInt(amountWei),
  }), 'send ETH transaction')
  const receipt = await withEthereumRpcTimeout(tx.wait(), 'wait for ETH transaction receipt')
  return {
    signature: tx.hash,
    fee: receipt?.fee ? receipt.fee.toString() : undefined,
  }
}

export function encodeEthereumContractCall(
  abi: unknown,
  functionName: string,
  args: unknown[] | Record<string, unknown> = [],
): { data: string; fragment: string } {
  const iface = new Interface(normalizeAbiInput(abi))
  const fragment = iface.getFunction(functionName)
  if (!fragment) throw new Error(`Function not found in ABI: ${functionName}`)
  const normalizedArgs = normalizeFunctionArgs(fragment, args, functionName)
  return {
    data: iface.encodeFunctionData(fragment, normalizedArgs),
    fragment: fragment.format('full'),
  }
}

export async function callEthereumContract(
  encryptedPrivateKey: string,
  input: {
    contractAddress: string
    abi: unknown
    functionName: string
    args?: unknown[] | Record<string, unknown>
  },
  options?: EthereumExecutionOptions,
): Promise<{
    network: EvmNetworkConfig
    address: string
    fragment: string
    data: string
    rawResult: string
    decoded: unknown
    namedOutputs: Record<string, unknown>
  }> {
  const network = getEvmNetworkConfig(options?.network)
  const provider = getProviderForNetwork(options?.network, options?.rpcUrl)
  const wallet = getWalletFromEncrypted(encryptedPrivateKey)
  const iface = new Interface(normalizeAbiInput(input.abi))
  const fragment = iface.getFunction(input.functionName)
  if (!fragment) throw new Error(`Function not found in ABI: ${input.functionName}`)
  const normalizedArgs = normalizeFunctionArgs(fragment, input.args || [], input.functionName)
  const data = iface.encodeFunctionData(fragment, normalizedArgs)
  const rawResult = await withEthereumRpcTimeout(provider.call({
    to: normalizeAddressInput(input.contractAddress, 'contractAddress'),
    data,
    from: wallet.address,
  }), `call contract ${input.functionName} on ${network.label}`)
  const decodedResult = iface.decodeFunctionResult(fragment, rawResult)
  const decodedValues = Array.from(decodedResult).map((entry) => serializeEvmValue(entry))
  const namedOutputs: Record<string, unknown> = {}
  for (let index = 0; index < fragment.outputs?.length; index += 1) {
    const output = fragment.outputs[index]
    if (!output?.name) continue
    namedOutputs[output.name] = serializeEvmValue(decodedResult[index])
  }

  return {
    network,
    address: wallet.address,
    fragment: fragment.format('full'),
    data,
    rawResult,
    decoded: decodedValues.length === 1 ? decodedValues[0] : decodedValues,
    namedOutputs,
  }
}

export async function signEthereumMessage(
  encryptedPrivateKey: string,
  input: EthereumMessageInput,
): Promise<{ signature: string; address: string }> {
  const wallet = getWalletFromEncrypted(encryptedPrivateKey)
  return {
    signature: await wallet.signMessage(normalizeMessageInput(input)),
    address: wallet.address,
  }
}

export async function signEthereumTypedData(
  encryptedPrivateKey: string,
  input: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    value: Record<string, unknown>
  },
): Promise<{ signature: string; address: string }> {
  const wallet = getWalletFromEncrypted(encryptedPrivateKey)
  return {
    signature: await wallet.signTypedData(
      normalizeTypedDataDomain(input.domain),
      normalizeTypedDataTypes(input.types),
      input.value,
    ),
    address: wallet.address,
  }
}

export async function signEthereumTransaction(
  encryptedPrivateKey: string,
  tx: Record<string, unknown>,
  options?: EthereumExecutionOptions,
): Promise<{
    signedTransaction: string
    transactionHash: string
    address: string
    chainId: number | null
    network: EvmNetworkConfig
  }> {
  const { wallet, txRequest, network } = await resolveWalletAndTransaction(encryptedPrivateKey, tx, options)
  const signedTransaction = await wallet.signTransaction(txRequest)
  return {
    signedTransaction,
    transactionHash: keccak256(signedTransaction),
    address: wallet.address,
    chainId: txRequest.chainId != null ? Number(txRequest.chainId) : null,
    network,
  }
}

export async function simulateEthereumTransaction(
  encryptedPrivateKey: string,
  tx: Record<string, unknown>,
  options?: EthereumExecutionOptions,
): Promise<{
    estimateGas?: string
    callResult?: string
    callError?: string
    address: string
    chainId: number | null
    network: EvmNetworkConfig
  }> {
  const { provider, wallet, txRequest, network } = await resolveWalletAndTransaction(encryptedPrivateKey, tx, options)
  let estimateGas: string | undefined
  let callResult: string | undefined
  let callError: string | undefined

  try {
    estimateGas = (await withEthereumRpcTimeout(
      provider.estimateGas({ ...txRequest, from: wallet.address }),
      `estimate gas on ${network.label}`,
    )).toString()
  } catch (err: unknown) {
    callError = errorMessage(err)
  }

  try {
    callResult = await withEthereumRpcTimeout(
      provider.call({ ...txRequest, from: wallet.address }),
      `simulate transaction call on ${network.label}`,
    )
  } catch (err: unknown) {
    if (!callError) callError = errorMessage(err)
  }

  return {
    estimateGas,
    callResult,
    callError,
    address: wallet.address,
    chainId: txRequest.chainId != null ? Number(txRequest.chainId) : null,
    network,
  }
}

export async function sendEthereumTransaction(
  encryptedPrivateKey: string,
  input: {
    transaction?: Record<string, unknown>
    signedTransaction?: string | null
    waitForReceipt?: boolean
  },
  options?: EthereumExecutionOptions,
): Promise<{
    transactionHash: string
    address: string
    chainId: number | null
    explorerUrl: string
    receipt?: Record<string, unknown> | null
    network: EvmNetworkConfig
  }> {
  const waitForReceipt = input.waitForReceipt === true
  const network = getEvmNetworkConfig(options?.network)
  const provider = getProviderForNetwork(options?.network, options?.rpcUrl)
  const wallet = getWalletFromEncrypted(encryptedPrivateKey).connect(provider)

  if (typeof input.signedTransaction === 'string' && input.signedTransaction.trim()) {
    const response = await withEthereumRpcTimeout(
      provider.broadcastTransaction(input.signedTransaction.trim()),
      `broadcast signed transaction on ${network.label}`,
    )
    const receipt = waitForReceipt
      ? await withEthereumRpcTimeout(response.wait(), `wait for transaction receipt on ${network.label}`)
      : null
    return {
      transactionHash: response.hash,
      address: wallet.address,
      chainId: network.chainId,
      explorerUrl: getEvmExplorerUrl(network.id, 'transaction', response.hash),
      receipt: receipt ? {
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed?.toString?.(),
        fee: receipt.fee?.toString?.(),
        status: receipt.status,
      } : null,
      network,
    }
  }

  if (!input.transaction || typeof input.transaction !== 'object') {
    throw new Error('transaction or signedTransaction is required')
  }

  const { txRequest } = await resolveWalletAndTransaction(encryptedPrivateKey, input.transaction, options)
  const response = await withEthereumRpcTimeout(
    wallet.sendTransaction(txRequest),
    `send transaction on ${network.label}`,
  )
  const receipt = waitForReceipt
    ? await withEthereumRpcTimeout(response.wait(), `wait for transaction receipt on ${network.label}`)
    : null
  return {
    transactionHash: response.hash,
    address: wallet.address,
    chainId: txRequest.chainId != null ? Number(txRequest.chainId) : network.chainId,
    explorerUrl: getEvmExplorerUrl(network.id, 'transaction', response.hash),
    receipt: receipt ? {
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed?.toString?.(),
      fee: receipt.fee?.toString?.(),
      status: receipt.status,
    } : null,
    network,
  }
}

export function isValidEthereumAddress(address: string): boolean {
  return isAddress(address)
}
