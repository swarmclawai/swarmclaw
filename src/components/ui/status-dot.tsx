import { cn } from '@/lib/utils'

const STATUS_COLORS: Record<string, string> = {
  online: 'bg-emerald-400',
  offline: 'bg-red-400',
  warning: 'bg-amber-400',
  idle: 'bg-text-3/50',
  paused: 'bg-amber-400',
}

const SIZE_CLASSES: Record<string, string> = {
  sm: 'w-1.5 h-1.5',
  md: 'w-2 h-2',
}

interface StatusDotProps {
  status: 'online' | 'offline' | 'warning' | 'idle' | 'paused'
  size?: 'sm' | 'md'
  pulse?: boolean
  glow?: boolean
  className?: string
}

export function StatusDot({ status, size = 'md', pulse, glow, className }: StatusDotProps) {
  return (
    <div
      className={cn(
        'rounded-full shrink-0',
        SIZE_CLASSES[size],
        STATUS_COLORS[status],
        pulse && 'animate-pulse',
        glow && status === 'online' && 'shadow-[0_0_6px_rgba(52,211,153,0.4)]',
        className,
      )}
    />
  )
}
