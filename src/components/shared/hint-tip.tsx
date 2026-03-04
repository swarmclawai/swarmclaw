'use client'

import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

interface Props {
  text: string
  side?: 'top' | 'bottom' | 'left' | 'right'
}

export function HintTip({ text, side = 'top' }: Props) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex items-center justify-center w-[14px] h-[14px] rounded-full border border-white/[0.12]
            text-[9px] font-600 text-text-3/50 hover:text-text-3 hover:border-white/[0.2] transition-colors cursor-help select-none shrink-0"
          aria-label="More info"
        >
          ?
        </span>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        sideOffset={6}
        className="bg-raised border border-white/[0.08] text-text shadow-[0_8px_32px_rgba(0,0,0,0.5)] rounded-[8px] px-2.5 py-1.5 text-[11px] max-w-[240px]"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
