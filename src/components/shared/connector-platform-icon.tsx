import type { Connector, ConnectorPlatform, Session } from '@/types'
import { cn } from '@/lib/utils'
import { BsMicrosoftTeams } from 'react-icons/bs'
import {
  SiApple,
  SiDiscord,
  SiGooglechat,
  SiMatrix,
  SiSignal,
  SiSlack,
  SiTelegram,
  SiWhatsapp,
} from 'react-icons/si'

export const CONNECTOR_PLATFORM_META: Record<ConnectorPlatform, { label: string; color: string }> = {
  discord: { label: 'Discord', color: '#5865F2' },
  telegram: { label: 'Telegram', color: '#229ED9' },
  slack: { label: 'Slack', color: '#4A154B' },
  whatsapp: { label: 'WhatsApp', color: '#25D366' },
  openclaw: { label: 'OpenClaw', color: '#F97316' },
  bluebubbles: { label: 'BlueBubbles', color: '#2E89FF' },
  signal: { label: 'Signal', color: '#3A76F0' },
  teams: { label: 'Teams', color: '#6264A7' },
  googlechat: { label: 'Google Chat', color: '#00AC47' },
  matrix: { label: 'Matrix', color: '#0DBD8B' },
  email: { label: 'Email', color: '#EA4335' },
  webchat: { label: 'Web Chat', color: '#0EA5E9' },
  mockmail: { label: 'MockMail', color: '#7C3AED' },
  swarmdock: { label: 'SwarmDock', color: '#F59E0B' },
}

const FALLBACK_CONNECTOR_PLATFORM_META = { label: 'Connector', color: '#64748B' } as const

function formatUnknownConnectorPlatformLabel(platform: string): string {
  const trimmed = platform.trim()
  if (!trimmed) return FALLBACK_CONNECTOR_PLATFORM_META.label
  return trimmed
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

export function resolveConnectorPlatformMeta(platform: string): { label: string; color: string } {
  const known = CONNECTOR_PLATFORM_META[platform as ConnectorPlatform]
  if (known) return known
  return {
    label: formatUnknownConnectorPlatformLabel(platform),
    color: FALLBACK_CONNECTOR_PLATFORM_META.color,
  }
}

export function getConnectorPlatformLabel(platform: string): string {
  return resolveConnectorPlatformMeta(platform).label
}

export function getConnectorIdFromSessionName(sessionName?: string | null): string | null {
  if (!sessionName || !sessionName.startsWith('connector:')) return null
  const parts = sessionName.split(':')
  return parts.length >= 2 && parts[1] ? parts[1] : null
}

export function getSessionConnector(
  session: Pick<Session, 'name'>,
  connectors: Record<string, Connector>,
): Connector | null {
  const connectorId = getConnectorIdFromSessionName(session.name)
  if (!connectorId) return null
  return connectors[connectorId] || null
}

interface ConnectorPlatformIconProps {
  platform: string
  size?: number
  className?: string
}

export function ConnectorPlatformIcon({
  platform,
  size = 14,
  className,
}: ConnectorPlatformIconProps) {
  switch (platform) {
    case 'discord':
      return <SiDiscord size={size} className={className} />
    case 'telegram':
      return <SiTelegram size={size} className={className} />
    case 'slack':
      return <SiSlack size={size} className={className} />
    case 'whatsapp':
      return <SiWhatsapp size={size} className={className} />
    case 'bluebubbles':
      return <SiApple size={size} className={className} />
    case 'signal':
      return <SiSignal size={size} className={className} />
    case 'googlechat':
      return <SiGooglechat size={size} className={className} />
    case 'matrix':
      return <SiMatrix size={size} className={className} />
    case 'teams':
      return <BsMicrosoftTeams size={size} className={className} />
    case 'openclaw':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className={className}>
          {/* OpenClaw pixel lobster mark */}
          <g fill="#3a0a0d">
            <rect x="1" y="5" width="1" height="3" />
            <rect x="2" y="4" width="1" height="1" />
            <rect x="2" y="8" width="1" height="1" />
            <rect x="3" y="3" width="1" height="1" />
            <rect x="3" y="9" width="1" height="1" />
            <rect x="4" y="2" width="1" height="1" />
            <rect x="4" y="10" width="1" height="1" />
            <rect x="5" y="2" width="6" height="1" />
            <rect x="11" y="2" width="1" height="1" />
            <rect x="12" y="3" width="1" height="1" />
            <rect x="12" y="9" width="1" height="1" />
            <rect x="13" y="4" width="1" height="1" />
            <rect x="13" y="8" width="1" height="1" />
            <rect x="14" y="5" width="1" height="3" />
            <rect x="5" y="11" width="6" height="1" />
            <rect x="4" y="12" width="1" height="1" />
            <rect x="11" y="12" width="1" height="1" />
            <rect x="3" y="13" width="1" height="1" />
            <rect x="12" y="13" width="1" height="1" />
            <rect x="5" y="14" width="6" height="1" />
          </g>
          <g fill="#ff4f40">
            <rect x="5" y="3" width="6" height="1" />
            <rect x="4" y="4" width="8" height="1" />
            <rect x="3" y="5" width="10" height="1" />
            <rect x="3" y="6" width="10" height="1" />
            <rect x="3" y="7" width="10" height="1" />
            <rect x="4" y="8" width="8" height="1" />
            <rect x="5" y="9" width="6" height="1" />
            <rect x="5" y="12" width="6" height="1" />
            <rect x="6" y="13" width="4" height="1" />
          </g>
          <g fill="#ff775f">
            <rect x="1" y="6" width="2" height="1" />
            <rect x="2" y="5" width="1" height="1" />
            <rect x="2" y="7" width="1" height="1" />
            <rect x="13" y="6" width="2" height="1" />
            <rect x="13" y="5" width="1" height="1" />
            <rect x="13" y="7" width="1" height="1" />
          </g>
          <g fill="#081016">
            <rect x="6" y="5" width="1" height="1" />
            <rect x="9" y="5" width="1" height="1" />
          </g>
          <g fill="#f5fbff">
            <rect x="6" y="4" width="1" height="1" />
            <rect x="9" y="4" width="1" height="1" />
          </g>
        </svg>
      )
    default:
      return (
        <span
          aria-hidden
          className={cn('inline-flex items-center justify-center rounded-full font-700 uppercase', className)}
          style={{ width: size, height: size, fontSize: Math.max(8, Math.floor(size * 0.5)), lineHeight: 1 }}
        >
          {getConnectorPlatformLabel(platform).charAt(0)}
        </span>
      )
  }
}

interface ConnectorPlatformBadgeProps {
  platform: string
  size?: number
  iconSize?: number
  className?: string
  roundedClassName?: string
  title?: string
}

export function ConnectorPlatformBadge({
  platform,
  size = 36,
  iconSize,
  className,
  roundedClassName = 'rounded-[10px]',
  title,
}: ConnectorPlatformBadgeProps) {
  const meta = resolveConnectorPlatformMeta(platform)
  const glyphSize = iconSize ?? Math.max(12, Math.floor(size * 0.52))

  return (
    <span
      title={title || `${meta.label} connector`}
      className={cn('inline-flex items-center justify-center shrink-0', roundedClassName, className)}
      style={{ width: size, height: size, backgroundColor: meta.color }}
    >
      <ConnectorPlatformIcon platform={platform} size={glyphSize} className="text-white" />
    </span>
  )
}
