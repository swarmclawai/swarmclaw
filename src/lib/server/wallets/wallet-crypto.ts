import { encryptKey, decryptKey } from '@/lib/server/storage'

/**
 * Generate a new Ethereum wallet (Base L2 compatible) with an encrypted private key.
 * Uses ethers v6 for keypair generation and the existing AES-256-GCM encryption
 * from storage.ts (CREDENTIAL_SECRET env var).
 */
export async function generateEthereumWallet(): Promise<{ address: string; encryptedPrivateKey: string }> {
  const { Wallet } = await import('ethers')
  const wallet = Wallet.createRandom()
  const encryptedPrivateKey = encryptKey(wallet.privateKey)
  return {
    address: wallet.address,
    encryptedPrivateKey,
  }
}

export async function normalizeEthereumAddress(address: string): Promise<string | null> {
  const { getAddress } = await import('ethers')
  try {
    return getAddress(address.trim())
  } catch {
    return null
  }
}

/**
 * Decrypt a wallet's private key for server-side use only.
 * Never expose the result to API responses or the frontend.
 */
export function decryptWalletPrivateKey(encrypted: string): string {
  return decryptKey(encrypted)
}
