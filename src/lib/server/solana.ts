import { Keypair, Connection, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { encryptKey, decryptKey } from './storage'

const DEFAULT_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'

// ---------------------------------------------------------------------------
// Keypair generation & encryption
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export function getConnection(rpcUrl?: string): Connection {
  return new Connection(rpcUrl || DEFAULT_RPC_URL, 'confirmed')
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

export async function getBalance(publicKey: string, rpcUrl?: string): Promise<number> {
  const connection = getConnection(rpcUrl)
  const pk = new PublicKey(publicKey)
  return connection.getBalance(pk)
}

// ---------------------------------------------------------------------------
// Send SOL
// ---------------------------------------------------------------------------

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

  // Fetch fee from confirmed tx
  let fee = 5000 // default fee estimate
  try {
    const txInfo = await connection.getTransaction(signature, { commitment: 'confirmed' })
    if (txInfo?.meta?.fee) fee = txInfo.meta.fee
  } catch {
    // use default
  }

  return { signature, fee }
}

// ---------------------------------------------------------------------------
// Recent transactions
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Validate address
// ---------------------------------------------------------------------------

export function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL
}

export function solToLamports(sol: number): number {
  return Math.round(sol * LAMPORTS_PER_SOL)
}
