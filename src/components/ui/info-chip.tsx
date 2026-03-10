import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const chipVariants = cva(
  'inline-flex items-center gap-1.5 font-600 shrink-0',
  {
    variants: {
      size: {
        sm: 'px-1.5 py-0.5 rounded-[4px] text-[10px]',
        md: 'px-2 py-1 rounded-[7px] text-[10px]',
      },
      tone: {
        neutral: 'bg-white/[0.05] text-text-2',
        muted: 'bg-white/[0.04] text-text-3',
        warning: 'bg-amber-500/10 text-amber-300',
        danger: 'bg-red-500/15 text-red-400',
        success: 'bg-emerald-500/15 text-emerald-400',
        info: 'bg-sky-500/10 text-sky-300',
        purple: 'bg-purple-500/10 text-purple-300',
        accent: 'bg-accent-bright/15 text-accent-bright',
      },
    },
    defaultVariants: {
      size: 'md',
      tone: 'neutral',
    },
  },
)

interface InfoChipProps extends VariantProps<typeof chipVariants> {
  children: React.ReactNode
  className?: string
}

export function InfoChip({ size, tone, children, className }: InfoChipProps) {
  return (
    <span className={cn(chipVariants({ size, tone }), className)}>
      {children}
    </span>
  )
}

export { chipVariants }
