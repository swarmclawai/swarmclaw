import { cn } from '@/lib/utils'

interface SectionHeaderProps {
  label: string
  count?: number
  action?: { label: string; onClick: () => void }
  className?: string
}

export function SectionHeader({ label, count, action, className }: SectionHeaderProps) {
  return (
    <div className={cn('flex items-center justify-between mb-3', className)}>
      <h2 className="font-display text-[13px] font-600 text-text-2 uppercase tracking-[0.08em] flex items-center gap-2">
        {label}
        {count != null && (
          <span className="text-[11px] font-500 text-text-3/50 normal-case tracking-normal">
            {count}
          </span>
        )}
      </h2>
      {action && (
        <button
          onClick={action.onClick}
          className="text-[11px] text-text-3/50 hover:text-text-3 transition-colors bg-transparent border-none cursor-pointer"
          style={{ fontFamily: 'inherit' }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}
