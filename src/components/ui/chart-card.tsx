import { cn } from '@/lib/utils'

interface ChartCardProps {
  title: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export function ChartCard({ title, actions, children, className }: ChartCardProps) {
  return (
    <div className={cn('bg-surface-2 rounded-[12px] p-5 border border-white/[0.04] hover:border-white/[0.1] transition-colors', className)}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display text-[14px] font-600 text-text-2">{title}</h3>
        {actions}
      </div>
      {children}
    </div>
  )
}
