'use client'

import { memo, useMemo } from 'react'
import { splitThinkingSteps } from './thinking-steps'

/** Strip simple leading markdown markers so the outline reads cleanly. */
function cleanSummary(line: string): string {
  return line.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim()
}

const ThinkingStepRow = memo(function ThinkingStepRow({
  firstLine,
  full,
  hasMore,
  index,
}: {
  firstLine: string
  full: string
  hasMore: boolean
  index: number
}) {
  const summary = useMemo(() => cleanSummary(firstLine), [firstLine])

  if (!hasMore) {
    return (
      <div className="flex items-start gap-2 px-1 py-1">
        <span className="text-[10px] font-mono text-purple-400/40 shrink-0 w-5 text-right mt-0.5">{index + 1}.</span>
        <span className="text-[13px] leading-[1.5] text-text-3/70 min-w-0 break-words">{summary}</span>
      </div>
    )
  }

  return (
    <details className="group/step">
      <summary className="flex items-start gap-2 px-1 py-1 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-purple-500/[0.04] rounded-[6px]">
        <span className="text-[10px] font-mono text-purple-400/40 shrink-0 w-5 text-right mt-0.5">{index + 1}.</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="text-purple-400/50 shrink-0 mt-1 transition-transform group-open/step:rotate-90">
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <span className="text-[13px] leading-[1.5] text-text-2/85 min-w-0 truncate">{summary}</span>
      </summary>
      <div className="pl-7 pr-1 pb-2 pt-0.5">
        <div className="text-[13px] leading-[1.6] text-text-3/70 whitespace-pre-wrap break-words">{full}</div>
      </div>
    </details>
  )
})

/**
 * Renders a model's thinking as an outline: one line per reasoning step. Steps
 * with extra detail beyond their first line expand inline on click.
 */
export const ThinkingStepsView = memo(function ThinkingStepsView({ thinking }: { thinking: string }) {
  const steps = useMemo(() => splitThinkingSteps(thinking), [thinking])
  if (steps.length === 0) return null

  return (
    <div className="flex flex-col gap-0.5" data-testid="thinking-steps">
      {steps.map((step, i) => (
        <ThinkingStepRow key={i} firstLine={step.firstLine} full={step.full} hasMore={step.hasMore} index={i} />
      ))}
    </div>
  )
})
