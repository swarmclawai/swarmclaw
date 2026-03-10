import { cn } from '@/lib/utils'

interface FilterPillProps {
  label: string
  active?: boolean
  onClick: () => void
  className?: string
}

export function FilterPill({ label, active, onClick, className }: FilterPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-2.5 py-1 rounded-[8px] text-[10px] font-700 uppercase tracking-[0.08em] border transition-all cursor-pointer bg-transparent',
        active
          ? 'bg-accent-soft border-accent-bright/15 text-accent-bright'
          : 'border-white/[0.05] text-text-3/70 hover:bg-white/[0.03] hover:text-text-2',
        className,
      )}
      style={{ fontFamily: 'inherit' }}
    >
      {label}
    </button>
  )
}
