'use client'

import { useMemo } from 'react'
import multiavatar from '@multiavatar/multiavatar'

interface Props {
  seed?: string | null
  name: string
  size?: number
  className?: string
}

export function AgentAvatar({ seed, name, size = 32, className = '' }: Props) {
  const svgHtml = useMemo(() => {
    if (!seed) return null
    return multiavatar(seed)
  }, [seed])

  if (svgHtml) {
    return (
      <div
        className={`shrink-0 rounded-full overflow-hidden ${className}`}
        style={{ width: size, height: size }}
        dangerouslySetInnerHTML={{ __html: svgHtml }}
      />
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
      className={`shrink-0 rounded-full flex items-center justify-center bg-accent-soft text-accent-bright font-600 ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials || '?'}
    </div>
  )
}
