import type { Connector } from '@/types'
import { createCredentialRecord, resolveCredentialSecret } from '@/lib/server/credentials/credential-service'
import { upsertConnector } from './connector-repository'
import { notify } from '@/lib/server/ws-hub'

export const SWARMMDOCK_CREDENTIAL_PROVIDER = 'swarmdock'

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function cloneConfig(config: Record<string, string> | null | undefined): Record<string, string> {
  return config ? { ...config } : {}
}

function getLegacyPrivateKey(config: Record<string, string> | null | undefined): string {
  return clean(config?.privateKey)
}

function stripLegacyPrivateKey(config: Record<string, string> | null | undefined): Record<string, string> {
  const next = cloneConfig(config)
  delete next.privateKey
  return next
}

function buildCredentialName(connectorName: string): string {
  const normalizedName = clean(connectorName)
  return normalizedName ? `${normalizedName} SwarmDock Identity Key` : 'SwarmDock Identity Key'
}

function persistConnectorSecretMigration(
  connector: Connector,
  credentialId: string,
): Connector {
  const nextConfig = stripLegacyPrivateKey(connector.config)
  const next: Connector = {
    ...connector,
    credentialId,
    config: nextConfig,
    updatedAt: Date.now(),
  }
  upsertConnector(next.id, next)
  notify('connectors')
  return next
}

export function redactConnectorSecrets<T extends Connector>(connector: T): T {
  if (connector.platform !== 'swarmdock') {
    return {
      ...connector,
      config: cloneConfig(connector.config),
    }
  }
  return {
    ...connector,
    config: stripLegacyPrivateKey(connector.config),
  }
}

export function prepareSwarmdockConnectorInput(params: {
  platform: Connector['platform']
  name: string
  credentialId: string | null
  config: Record<string, string> | null | undefined
}): {
  credentialId: string | null
  config: Record<string, string>
} {
  const config = cloneConfig(params.config)
  if (params.platform !== 'swarmdock') {
    return {
      credentialId: clean(params.credentialId) || null,
      config,
    }
  }

  const credentialId = clean(params.credentialId)
  const legacyPrivateKey = getLegacyPrivateKey(config)
  if (!legacyPrivateKey) {
    return {
      credentialId: credentialId || null,
      config: stripLegacyPrivateKey(config),
    }
  }

  if (credentialId) {
    return {
      credentialId,
      config: stripLegacyPrivateKey(config),
    }
  }

  const credential = createCredentialRecord({
    provider: SWARMMDOCK_CREDENTIAL_PROVIDER,
    name: buildCredentialName(params.name),
    apiKey: legacyPrivateKey,
  })

  return {
    credentialId: credential.id,
    config: stripLegacyPrivateKey(config),
  }
}

export function ensureSwarmdockConnectorCredential(
  connector: Connector,
  options?: { allowMigrationFailureFallback?: boolean },
): {
  connector: Connector
  fallbackPrivateKey: string | null
} {
  if (connector.platform !== 'swarmdock') {
    return { connector, fallbackPrivateKey: null }
  }

  const legacyPrivateKey = getLegacyPrivateKey(connector.config)
  if (!legacyPrivateKey) {
    return { connector, fallbackPrivateKey: null }
  }

  const configuredCredentialId = clean(connector.credentialId)
  if (configuredCredentialId) {
    if (resolveCredentialSecret(configuredCredentialId)) {
      return {
        connector: persistConnectorSecretMigration(connector, configuredCredentialId),
        fallbackPrivateKey: null,
      }
    }
    return {
      connector,
      fallbackPrivateKey: legacyPrivateKey,
    }
  }

  try {
    const credential = createCredentialRecord({
      provider: SWARMMDOCK_CREDENTIAL_PROVIDER,
      name: buildCredentialName(connector.name),
      apiKey: legacyPrivateKey,
    })
    return {
      connector: persistConnectorSecretMigration(connector, credential.id),
      fallbackPrivateKey: null,
    }
  } catch (error) {
    if (!options?.allowMigrationFailureFallback) throw error
    return {
      connector,
      fallbackPrivateKey: legacyPrivateKey,
    }
  }
}
