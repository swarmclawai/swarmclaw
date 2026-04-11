import type { Credential } from '@/types'

import { genId } from '@/lib/id'
import {
  deleteCredential,
  decryptKey,
  encryptKey,
  loadCredential,
  loadCredentials,
  saveCredential,
} from '@/lib/server/credentials/credential-repository'
import { log } from '@/lib/server/logger'

const TAG = 'credential-service'

export type CredentialSummary = Pick<Credential, 'id' | 'provider' | 'name' | 'createdAt'>

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function toCredentialSummary(credential: Credential | null | undefined): CredentialSummary | null {
  if (!credential) return null
  return {
    id: credential.id,
    provider: credential.provider,
    name: credential.name,
    createdAt: credential.createdAt,
  }
}

export function listCredentialSummaries(): Record<string, CredentialSummary> {
  const credentials = loadCredentials()
  const summaries: Record<string, CredentialSummary> = {}
  for (const [id, credential] of Object.entries(credentials)) {
    const summary = toCredentialSummary(credential)
    if (summary) summaries[id] = summary
  }
  return summaries
}

export function getCredentialSummary(id: string): CredentialSummary | null {
  return toCredentialSummary(loadCredential(id))
}

export function listCredentialIdsByProvider(provider: string): string[] {
  const normalizedProvider = clean(provider)
  if (!normalizedProvider) return []
  return Object.entries(loadCredentials())
    .filter(([, credential]) => credential?.provider === normalizedProvider)
    .map(([id]) => id)
}

export function resolveCredentialSecret(credentialId: string | null | undefined): string | null {
  const id = clean(credentialId)
  if (!id) return null
  const credential = loadCredential(id)
  if (!credential?.encryptedKey) return null
  try {
    return decryptKey(credential.encryptedKey)
  } catch (err) {
    log.warn(TAG, `Failed to decrypt credential "${id}" — CREDENTIAL_SECRET may have changed since this key was stored. Re-add the API key to fix.`, {
      credentialId: id,
      provider: credential.provider,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export function requireCredentialSecret(
  credentialId: string | null | undefined,
  missingMessage = 'Credential secret not found.',
): string {
  const id = clean(credentialId)
  if (!id) throw new Error(missingMessage)
  const credential = loadCredential(id)
  if (!credential?.encryptedKey) throw new Error(missingMessage)
  try {
    return decryptKey(credential.encryptedKey)
  } catch {
    throw new Error(missingMessage)
  }
}

export function createCredentialRecord(input: {
  provider: string
  name?: string | null
  apiKey: string
}): CredentialSummary {
  const provider = clean(input.provider)
  const apiKey = clean(input.apiKey)
  if (!provider || !apiKey) {
    throw new Error('provider and apiKey are required')
  }
  const id = `cred_${genId(6)}`
  const createdAt = Date.now()
  const credentialName = clean(input.name) || `${provider} key`
  saveCredential(id, {
    id,
    provider,
    name: credentialName,
    encryptedKey: encryptKey(apiKey),
    createdAt,
  })
  return {
    id,
    provider,
    name: credentialName,
    createdAt,
  }
}

export function deleteCredentialRecord(id: string): boolean {
  const credentialId = clean(id)
  if (!credentialId) return false
  if (!loadCredential(credentialId)) return false
  deleteCredential(credentialId)
  return true
}
