import type {
  PluginCatalogSource,
  PluginInstallSource,
  PluginPublisherSource,
} from '@/types'

const PUBLISHER_SOURCES = ['builtin', 'local', 'manual', 'swarmclaw', 'swarmforge', 'clawhub'] as const
const CATALOG_SOURCES = ['swarmclaw', 'swarmclaw-site', 'swarmforge', 'clawhub'] as const
const INSTALL_SOURCES = ['builtin', 'local', 'manual', ...CATALOG_SOURCES] as const

const SOURCE_LABELS: Record<PluginInstallSource | PluginPublisherSource, string> = {
  builtin: 'Built-in',
  local: 'Local file',
  manual: 'Manual URL',
  swarmclaw: 'SwarmClaw',
  'swarmclaw-site': 'SwarmClaw Site',
  swarmforge: 'SwarmForge',
  clawhub: 'ClawHub',
}

export function normalizePluginPublisherSource(raw: unknown): PluginPublisherSource | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!value) return undefined
  return (PUBLISHER_SOURCES as readonly string[]).includes(value)
    ? value as PluginPublisherSource
    : undefined
}

export function normalizePluginCatalogSource(raw: unknown): PluginCatalogSource | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!value) return undefined
  return (CATALOG_SOURCES as readonly string[]).includes(value)
    ? value as PluginCatalogSource
    : undefined
}

export function normalizePluginInstallSource(raw: unknown): PluginInstallSource | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!value) return undefined
  return (INSTALL_SOURCES as readonly string[]).includes(value)
    ? value as PluginInstallSource
    : undefined
}

export function inferPluginPublisherSourceFromUrl(url: string | null | undefined): PluginPublisherSource | undefined {
  const normalized = typeof url === 'string' ? url.trim().toLowerCase() : ''
  if (!normalized) return undefined
  if (normalized.includes('clawhub.ai')) return 'clawhub'
  if (normalized.includes('swarmclaw.ai/')) return 'swarmclaw'
  if (
    normalized.includes('raw.githubusercontent.com/swarmclawai/swarmforge/')
    || normalized.includes('github.com/swarmclawai/swarmforge/')
    || normalized.includes('/swarmclawai/plugins/')
  ) {
    return 'swarmforge'
  }
  return undefined
}

export function inferPluginInstallSourceFromUrl(url: string | null | undefined): PluginInstallSource | undefined {
  const publisherSource = inferPluginPublisherSourceFromUrl(url)
  if (publisherSource === 'swarmclaw' || publisherSource === 'swarmforge' || publisherSource === 'clawhub') {
    return publisherSource
  }
  return undefined
}

export function isMarketplaceInstallSource(source: PluginInstallSource | null | undefined): boolean {
  return source === 'swarmclaw' || source === 'swarmclaw-site' || source === 'swarmforge' || source === 'clawhub'
}

export function getPluginSourceLabel(
  source: PluginInstallSource | PluginPublisherSource | PluginCatalogSource | null | undefined,
): string {
  if (!source) return 'Unknown'
  return SOURCE_LABELS[source as keyof typeof SOURCE_LABELS] || source
}
