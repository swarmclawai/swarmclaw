/**
 * Credential injection and secret redaction for agent code execution.
 *
 * Resolves an agent's configured credentials from the credential store,
 * returns them as env vars for injection, and provides a redaction function
 * to scrub secrets from execution output.
 */

import { loadCredentials, decryptKey } from '../storage'
import { log } from '../logger'
import type { Credential } from '@/types'

const TAG = 'credential-env'

export interface CredentialEnv {
  /** Environment variables to inject (name → decrypted value) */
  env: Record<string, string>
  /** Raw secret values for redaction */
  secrets: string[]
}

/**
 * Build credential environment variables for an agent execution.
 *
 * Each credential ID in the list is resolved from the credential store,
 * decrypted, and mapped to an env var name derived from the credential's
 * provider and name fields.
 *
 * Env var naming: `<PROVIDER>_API_KEY` for the primary key, or
 * `<PROVIDER>_<NAME>` if a name is explicitly set. All uppercased,
 * non-alphanumeric chars replaced with underscores.
 */
export function buildCredentialEnv(credentialIds: string[]): CredentialEnv {
  if (!credentialIds.length) return { env: {}, secrets: [] }

  const env: Record<string, string> = {}
  const secrets: string[] = []

  const allCredentials = loadCredentials() as Record<string, Credential & { encryptedKey?: string }>

  for (const credId of credentialIds) {
    const cred = allCredentials[credId]
    if (!cred) {
      log.warn(TAG, `Credential not found: ${credId}`)
      continue
    }

    // Decrypt the stored key — credentials persist the ciphertext under
    // `encryptedKey` (see createCredentialRecord in storage.ts; matching
    // reads in connector-lifecycle, chatroom-helpers, daemon-state, etc.).
    // Previously this file read `cred.encrypted`, which is never set, so
    // credential injection silently no-op'd for every execute tool call.
    const encrypted = cred.encryptedKey
    if (!encrypted || typeof encrypted !== 'string') {
      log.warn(TAG, `Credential has no encrypted value: ${credId}`)
      continue
    }

    let value: string
    try {
      value = decryptKey(encrypted)
    } catch (err: unknown) {
      log.warn(TAG, `Failed to decrypt credential ${credId}`, { error: String(err) })
      continue
    }

    // Derive env var name
    const envVarName = deriveEnvVarName(cred.provider, cred.name)
    env[envVarName] = value
    secrets.push(value)
  }

  return { env, secrets }
}

/**
 * Derive an environment variable name from provider and credential name.
 * e.g., provider="openai", name="default" → "OPENAI_API_KEY"
 * e.g., provider="custom", name="my-service-token" → "CUSTOM_MY_SERVICE_TOKEN"
 */
function deriveEnvVarName(provider: string, name: string): string {
  const sanitize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')

  const providerKey = sanitize(provider)
  const nameKey = sanitize(name)

  // If name is generic (default, primary, key, api-key, etc.), use PROVIDER_API_KEY
  const genericNames = new Set(['DEFAULT', 'PRIMARY', 'KEY', 'API_KEY', 'APIKEY', ''])
  if (genericNames.has(nameKey)) {
    return `${providerKey}_API_KEY`
  }

  return `${providerKey}_${nameKey}`
}

/**
 * Redact secret values from execution output.
 *
 * Scans the text for any injected secret values and replaces them
 * with [REDACTED]. Only redacts secrets longer than 4 characters
 * to avoid false positives on short strings.
 */
export function redactSecrets(text: string, secrets: string[]): string {
  if (!secrets.length || !text) return text

  let result = text
  for (const secret of secrets) {
    if (secret.length > 4) {
      result = result.replaceAll(secret, '[REDACTED]')
    }
  }
  return result
}
