'use client'

import { useMemo } from 'react'
import multiavatar from '@multiavatar/multiavatar'

/** Strip scripts/event handlers from SVG to prevent XSS */
function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\bon\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\bon\w+\s*=\s*'[^']*'/gi, '')
}

interface Props {
  seed?: string | null
  avatarUrl?: string | null
  name: string
  size?: number
  className?: string
  status?: 'idle' | 'busy' | 'online'
  heartbeatPulse?: boolean
}

const STATUS_COLORS: Record<string, string> = {
  busy: 'bg-amber-400',
  online: 'bg-emerald-400',
}

const HEART_PATH = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'

export function AgentAvatar({ seed, avatarUrl, name, size = 32, className = '', status, heartbeatPulse }: Props) {
  const svgHtml = useMemo(() => {
    if (!seed) return null
    return sanitizeSvg(multiavatar(seed))
  }, [seed])

  const dotSize = Math.max(6, Math.round(size * 0.28))
  const dot = status && status !== 'idle' ? (
    <span
      className={`absolute -bottom-0.5 -right-0.5 rounded-full ${STATUS_COLORS[status]} ring-2 ring-[#0f0f1a]`}
      style={{
        width: dotSize,
        height: dotSize,
        animation: status === 'online' ? 'pulse-subtle 2s ease-in-out infinite' : undefined
      }}
      title={status === 'busy' ? 'Busy' : 'Online'}
    />
  ) : null

  const heartEl = heartbeatPulse ? (
    <svg
      className="absolute left-1/2 -translate-x-1/2 pointer-events-none"
      style={{ top: -Math.max(10, size * 0.35), width: 10, height: 10, animation: 'heartbeat-float 1.5s ease forwards' }}
      viewBox="0 0 24 24"
      fill="#22c55e"
    >
      <path d={HEART_PATH} />
    </svg>
  ) : null

  if (avatarUrl) {
    return (
      <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
        <div className="rounded-full overflow-hidden w-full h-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={avatarUrl} alt={name} className="w-full h-full object-cover" draggable={false} />
        </div>
        {heartEl}
        {dot}
      </div>
    )
  }

  if (svgHtml) {
    return (
      <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
        <div
          className="rounded-full overflow-hidden w-full h-full"
          dangerouslySetInnerHTML={{ __html: svgHtml }}
        />
        {heartEl}
        {dot}
      </div>
    )
  }

  // Fallback: initials
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase()

  return (
    <div
      className={`relative shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <div
        className="rounded-full flex items-center justify-center bg-accent-soft text-accent-bright font-600 w-full h-full"
        style={{ fontSize: size * 0.38 }}
      >
        {initials || '?'}
      </div>
      {heartEl}
      {dot}
    </div>
  )
}
