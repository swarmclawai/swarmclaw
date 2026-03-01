import type { Connector, ConnectorPlatform, Session } from '@/types'
import { cn } from '@/lib/utils'
import { BsMicrosoftTeams } from 'react-icons/bs'
import {
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
  signal: { label: 'Signal', color: '#3A76F0' },
  teams: { label: 'Teams', color: '#6264A7' },
  googlechat: { label: 'Google Chat', color: '#00AC47' },
  matrix: { label: 'Matrix', color: '#0DBD8B' },
}

export function getConnectorPlatformLabel(platform: ConnectorPlatform): string {
  return CONNECTOR_PLATFORM_META[platform]?.label || platform
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
  platform: ConnectorPlatform
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
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="M4 17l2-5 2 5" /><path d="M12 17l2-5 2 5" /><path d="M20 17l-2-5-2 5" />
          <path d="M2 7l4-4 3 3" /><path d="M22 7l-4-4-3 3" />
          <line x1="12" y1="3" x2="12" y2="8" />
        </svg>
      )
    default:
      return null
  }
}

interface ConnectorPlatformBadgeProps {
  platform: ConnectorPlatform
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
  const meta = CONNECTOR_PLATFORM_META[platform]
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
