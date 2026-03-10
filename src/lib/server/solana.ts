import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import bs58 from 'bs58'
import nacl from 'tweetnacl'

import { decryptKey, encryptKey } from './storage'

export type SolanaCluster = 'mainnet-beta' | 'devnet' | 'testnet'

export interface SolanaExecutionOptions {
  cluster?: SolanaCluster | string | null
  rpcUrl?: string | null
}

export interface SolanaMessageInput {
  message?: string | null
  messageHex?: string | null
  messageBase64?: string | null
}

const DEFAULT_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'

function getClusterRpcUrl(cluster: SolanaCluster): string {
  if (cluster === 'devnet') return process.env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com'
  if (cluster === 'testnet') return process.env.SOLANA_TESTNET_RPC_URL || 'https://api.testnet.solana.com'
  return process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
}

function normalizeHexMessage(value: string): Uint8Array {
  const trimmed = value.trim()
  if (!/^0x[0-9a-fA-F]*$/.test(trimmed)) {
    throw new Error('messageHex must be a 0x-prefixed hex string')
  }
  return Uint8Array.from(Buffer.from(trimmed.slice(2), 'hex'))
}

function normalizeMessageBytes(input: SolanaMessageInput): Uint8Array {
  if (typeof input.messageHex === 'string' && input.messageHex.trim()) return normalizeHexMessage(input.messageHex)
  if (typeof input.messageBase64 === 'string' && input.messageBase64.trim()) {
    return Uint8Array.from(Buffer.from(input.messageBase64.trim(), 'base64'))
  }
  if (typeof input.message === 'string') return new TextEncoder().encode(input.message)
  throw new Error('message, messageHex, or messageBase64 is required')
}

function deserializeTransactionBase64(value: string): Transaction | VersionedTransaction {
  const bytes = Buffer.from(value, 'base64')
  try {
    return VersionedTransaction.deserialize(bytes)
  } catch {
    return Transaction.from(bytes)
  }
}

function serializeTransactionBase64(transaction: Transaction | VersionedTransaction): string {
  return Buffer.from(transaction.serialize()).toString('base64')
}

function collectTransactionSignatures(transaction: Transaction | VersionedTransaction): string[] {
  if (transaction instanceof VersionedTransaction) {
    return transaction.signatures
      .map((signature) => bs58.encode(signature))
      .filter(Boolean)
  }
  return transaction.signatures
    .map((entry) => (entry.signature ? bs58.encode(entry.signature) : ''))
    .filter(Boolean)
}

function signTransactionWithWallet(
  encryptedPrivateKey: string,
  transaction: Transaction | VersionedTransaction,
): { transaction: Transaction | VersionedTransaction; publicKey: string } {
  const keypair = getKeypairFromEncrypted(encryptedPrivateKey)
  if (transaction instanceof VersionedTransaction) {
    transaction.sign([keypair])
  } else {
    transaction.sign(keypair)
  }
  return {
    transaction,
    publicKey: keypair.publicKey.toBase58(),
  }
}

export function generateSolanaKeypair(): { publicKey: string; encryptedPrivateKey: string } {
  const keypair = Keypair.generate()
  const secretKeyBase58 = bs58.encode(keypair.secretKey)
  return {
    publicKey: keypair.publicKey.toBase58(),
    encryptedPrivateKey: encryptKey(secretKeyBase58),
  }
}

export function getKeypairFromEncrypted(encryptedPrivateKey: string): Keypair {
  const secretKeyBase58 = decryptKey(encryptedPrivateKey)
  const secretKey = bs58.decode(secretKeyBase58)
  return Keypair.fromSecretKey(secretKey)
}

export function normalizeSolanaCluster(value: unknown, fallback: SolanaCluster = 'mainnet-beta'): SolanaCluster {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return fallback
  if (normalized === 'mainnet' || normalized === 'mainnet-beta' || normalized === 'solana') return 'mainnet-beta'
  if (normalized === 'devnet') return 'devnet'
  if (normalized === 'testnet') return 'testnet'
  throw new Error(`Unsupported Solana cluster: ${String(value)}`)
}

export function getSolanaClusterLabel(value?: unknown): string {
  const cluster = normalizeSolanaCluster(value)
  if (cluster === 'devnet') return 'Solana Devnet'
  if (cluster === 'testnet') return 'Solana Testnet'
  return 'Solana Mainnet'
}

export function getSolanaExplorerUrl(cluster: SolanaCluster | string | null | undefined, kind: 'address' | 'transaction', value: string): string {
  const normalized = normalizeSolanaCluster(cluster)
  const prefix = kind === 'address' ? 'address' : 'tx'
  const clusterSuffix = normalized === 'mainnet-beta' ? '' : `?cluster=${normalized}`
  return `https://explorer.solana.com/${prefix}/${value}${clusterSuffix}`
}

const connectionCache = new Map<string, Connection>()

function getCachedConnection(url: string): Connection {
  let conn = connectionCache.get(url)
  if (!conn) {
    conn = new Connection(url, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
    })
    connectionCache.set(url, conn)
  }
  return conn
}

export function getConnection(rpcUrl?: string): Connection {
  return getCachedConnection(rpcUrl || DEFAULT_RPC_URL)
}

export function getConnectionForCluster(cluster?: SolanaCluster | string | null, rpcUrl?: string | null): Connection {
  return getCachedConnection(rpcUrl || getClusterRpcUrl(normalizeSolanaCluster(cluster)))
}

export async function getBalance(publicKey: string, rpcUrl?: string): Promise<number> {
  const connection = getConnection(rpcUrl)
  const pk = new PublicKey(publicKey)
  return connection.getBalance(pk)
}

export async function sendSol(
  encryptedPrivateKey: string,
  toAddress: string,
  lamports: number,
  rpcUrl?: string,
): Promise<{ signature: string; fee: number }> {
  const connection = getConnection(rpcUrl)
  const fromKeypair = getKeypairFromEncrypted(encryptedPrivateKey)
  const toPublicKey = new PublicKey(toAddress)

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: toPublicKey,
      lamports,
    }),
  )

  const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair])

  let fee = 5000
  try {
    const txInfo = await connection.getTransaction(signature, { commitment: 'confirmed' })
    if (txInfo?.meta?.fee) fee = txInfo.meta.fee
  } catch {
    // keep default
  }

  return { signature, fee }
}

export async function signSolanaMessage(
  encryptedPrivateKey: string,
  input: SolanaMessageInput,
): Promise<{ signature: string; publicKey: string }> {
  const keypair = getKeypairFromEncrypted(encryptedPrivateKey)
  const signature = nacl.sign.detached(normalizeMessageBytes(input), keypair.secretKey)
  return {
    signature: bs58.encode(signature),
    publicKey: keypair.publicKey.toBase58(),
  }
}

export async function signSolanaTransaction(
  encryptedPrivateKey: string,
  transactionBase64: string,
): Promise<{
    signedTransactionBase64: string
    signatures: string[]
    publicKey: string
    versioned: boolean
  }> {
  const unsignedTx = deserializeTransactionBase64(transactionBase64)
  const { transaction, publicKey } = signTransactionWithWallet(encryptedPrivateKey, unsignedTx)
  return {
    signedTransactionBase64: serializeTransactionBase64(transaction),
    signatures: collectTransactionSignatures(transaction),
    publicKey,
    versioned: transaction instanceof VersionedTransaction,
  }
}

export async function simulateSolanaTransaction(
  encryptedPrivateKey: string,
  transactionBase64: string,
  options?: SolanaExecutionOptions,
): Promise<{
    signatures: string[]
    publicKey: string
    logs: string[]
    unitsConsumed?: number
    err?: unknown
    versioned: boolean
  }> {
  const unsignedTx = deserializeTransactionBase64(transactionBase64)
  const { transaction, publicKey } = signTransactionWithWallet(encryptedPrivateKey, unsignedTx)
  const connection = getConnectionForCluster(options?.cluster, options?.rpcUrl)
  const simulation = transaction instanceof VersionedTransaction
    ? await connection.simulateTransaction(transaction)
    : await connection.simulateTransaction(transaction)
  return {
    signatures: collectTransactionSignatures(transaction),
    publicKey,
    logs: simulation.value.logs || [],
    unitsConsumed: simulation.value.unitsConsumed ?? undefined,
    err: simulation.value.err ?? undefined,
    versioned: transaction instanceof VersionedTransaction,
  }
}

export async function sendSolanaTransaction(
  encryptedPrivateKey: string,
  input: {
    transactionBase64?: string | null
    signedTransactionBase64?: string | null
    waitForConfirmation?: boolean
  },
  options?: SolanaExecutionOptions,
): Promise<{
    signature: string
    publicKey: string
    explorerUrl: string
    versioned: boolean
  }> {
  const connection = getConnectionForCluster(options?.cluster, options?.rpcUrl)
  const keypair = getKeypairFromEncrypted(encryptedPrivateKey)
  const waitForConfirmation = input.waitForConfirmation !== false

  let transaction: Transaction | VersionedTransaction
  if (typeof input.signedTransactionBase64 === 'string' && input.signedTransactionBase64.trim()) {
    transaction = deserializeTransactionBase64(input.signedTransactionBase64.trim())
  } else if (typeof input.transactionBase64 === 'string' && input.transactionBase64.trim()) {
    transaction = signTransactionWithWallet(encryptedPrivateKey, deserializeTransactionBase64(input.transactionBase64.trim())).transaction
  } else {
    throw new Error('transactionBase64 or signedTransactionBase64 is required')
  }

  const raw = transaction.serialize()
  const signature = await connection.sendRawTransaction(raw)
  if (waitForConfirmation) {
    await connection.confirmTransaction(signature, 'confirmed')
  }

  return {
    signature,
    publicKey: keypair.publicKey.toBase58(),
    explorerUrl: getSolanaExplorerUrl(options?.cluster, 'transaction', signature),
    versioned: transaction instanceof VersionedTransaction,
  }
}

export async function getRecentTransactions(
  publicKey: string,
  limit = 20,
  rpcUrl?: string,
): Promise<Array<{ signature: string; blockTime: number | null; err: unknown }>> {
  const connection = getConnection(rpcUrl)
  const pk = new PublicKey(publicKey)
  const signatures = await connection.getSignaturesForAddress(pk, { limit })
  return signatures.map((s) => ({
    signature: s.signature,
    blockTime: s.blockTime ?? null,
    err: s.err,
  }))
}

export function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address)
    return true
  } catch {
    return false
  }
}

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL
}

export function solToLamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL)
}
