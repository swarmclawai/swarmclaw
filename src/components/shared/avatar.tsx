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

export type AiMood = 'idle' | 'thinking' | 'tool' | 'error' | 'success'

const moodAnimClass: Record<AiMood, string> = {
  idle: '',
  thinking: 'ai-mood-pulse',
  tool: 'ai-mood-glow',
  error: 'ai-mood-shake',
  success: 'ai-mood-bounce',
}

export function AiAvatar({ size = 'md', mood }: { size?: 'sm' | 'md'; mood?: AiMood }) {
  const s = size === 'sm' ? 'w-6 h-6' : 'w-8 h-8'
  const iconSize = size === 'sm' ? 12 : 16
  const animCls = mood ? moodAnimClass[mood] : ''
  return (
    <div className={`${s} rounded-[8px] bg-accent-soft flex items-center justify-center shrink-0 ${animCls}`}>
      <svg width={iconSize} height={iconSize} viewBox="0 0 24 24" fill="none" className="text-accent-bright">
        <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z"
          fill="currentColor" />
      </svg>
    </div>
  )
}
