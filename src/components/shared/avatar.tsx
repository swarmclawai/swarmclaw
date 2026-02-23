'use client'

interface Props {
  user: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
}

const sizes = {
  xs: 'w-6 h-6 text-[9px] rounded-[7px]',
  sm: 'w-7 h-7 text-[10px] rounded-[8px]',
  md: 'w-9 h-9 text-[13px] rounded-[10px]',
  lg: 'w-[72px] h-[72px] text-[24px] rounded-[22px]',
}

/** Generate a consistent gradient from a username */
function userGradient(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = Math.abs(hash) % 360
  return `linear-gradient(135deg, hsl(${hue}, 70%, 35%), hsl(${(hue + 30) % 360}, 75%, 50%))`
}

export function Avatar({ user, size = 'md' }: Props) {
  const initial = (user || '?')[0].toUpperCase()
  return (
    <div
      className={`${sizes[size]} flex items-center justify-center font-display font-600 tracking-tight shrink-0 text-white`}
      style={{ background: userGradient(user) }}
    >
      {initial}
    </div>
  )
}

export function AiAvatar({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const s = size === 'sm' ? 'w-6 h-6' : 'w-8 h-8'
  const iconSize = size === 'sm' ? 12 : 16
  return (
    <div className={`${s} rounded-[8px] bg-accent-soft flex items-center justify-center shrink-0`}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
        <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3 1.07.56 2 1.56 2 3a2.5 2.5 0 0 1-2.5 2.5z" />
        <path d="M12 2c0 2.22-1 3.5-2 5.5 2.5 1 5.5 5 5.5 9.5a5.5 5.5 0 1 1-11 0c0-1.55.64-2.31 1.54-3.5a14.95 14.95 0 0 1 1.05-3c-.15.14-.35.15-.45.15-1.5 0-2.39-1.39-2.39-2.65 0-2.12 1.56-4.49 1.86-4.99L12 2z" />
      </svg>
    </div>
  )
}
