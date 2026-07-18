'use client'

import { useTranslation } from 'react-i18next';
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

// 注意：平台名称保留英文，因为它们用于 API 通信和内部逻辑，但界面显示使用翻译
export const CONNECTOR_PLATFORM_META: Record<ConnectorPlatform, { labelKey: string; color: string }> = {
  discord: { labelKey: 'platformDiscord', color: '#5865F2' },
  telegram: { labelKey: 'platformTelegram', color: '#229ED9' },
  slack: { labelKey: 'platformSlack', color: '#4A154B' },
  whatsapp: { labelKey: 'platformWhatsApp', color: '#25D366' },
  openclaw: { labelKey: 'platformOpenClaw', color: '#F97316' },
  bluebubbles: { labelKey: 'platformBlueBubbles', color: '#2E89FF' },
  signal: { labelKey: 'platformSignal', color: '#3A76F0' },
  teams: { labelKey: 'platformTeams', color: '#6264A7' },
  googlechat: { labelKey: 'platformGoogleChat', color: '#00AC47' },
  matrix: { labelKey: 'platformMatrix', color: '#0DBD8B' },
  email: { labelKey: 'platformEmail', color: '#EA4335' },
  webchat: { labelKey: 'platformWebChat', color: '#0EA5E9' },
  mockmail: { labelKey: 'platformMockMail', color: '#7C3AED' },
  filequeue: { labelKey: 'platformFileQueue', color: '#22C55E' },
  swarmdock: { labelKey: 'platformSwarmDock', color: '#F59E0B' },
}

const FALLBACK_CONNECTOR_PLATFORM_META = { labelKey: 'platformConnector', color: '#64748B' } as const

function formatUnknownConnectorPlatformLabel(platform: string): string {
  const trimmed = platform.trim()
  if (!trimmed) return 'Connector'
  return trimmed
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ')
}

export function resolveConnectorPlatformMeta(platform: string): { labelKey: string; color: string } {
  const known = CONNECTOR_PLATFORM_META[platform as ConnectorPlatform]
  if (known) return known
  return {
    labelKey: `platform_${platform}`,
    color: FALLBACK_CONNECTOR_PLATFORM_META.color,
  }
}

export function getConnectorPlatformLabel(platform: string): string {
  const { t } = useTranslation()
  const meta = resolveConnectorPlatformMeta(platform)
  // 尝试获取翻译，如果不存在则回退到格式化后的平台名
  try {
    return t(meta.labelKey)
  } catch {
    return formatUnknownConnectorPlatformLabel(platform)
  }
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
  const { t } = useTranslation()
  const meta = resolveConnectorPlatformMeta(platform)
  const glyphSize = iconSize ?? Math.max(12, Math.floor(size * 0.52))
  const platformLabel = getConnectorPlatformLabel(platform)

  return (
    <span
      title={title || `${platformLabel} ${t('connectorLabel')}`}
      className={cn('inline-flex items-center justify-center shrink-0', roundedClassName, className)}
      style={{ width: size, height: size, backgroundColor: meta.color }}
    >
      <ConnectorPlatformIcon platform={platform} size={glyphSize} className="text-white" />
    </span>
  )
}
