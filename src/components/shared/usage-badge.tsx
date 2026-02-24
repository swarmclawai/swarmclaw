'use client'

interface Props {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCost: number
}

export function UsageBadge({ totalTokens, estimatedCost }: Props) {
  if (!totalTokens) return null

  const costStr = estimatedCost < 0.001
    ? '<$0.001'
    : `$${estimatedCost.toFixed(3)}`

  const tokenStr = totalTokens >= 1000
    ? `${(totalTokens / 1000).toFixed(1)}k`
    : String(totalTokens)

  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-[7px] bg-white/[0.04] text-[10px] font-mono text-text-3/60">
      <span>{tokenStr} tok</span>
      <span className="text-text-3/60">·</span>
      <span className="text-emerald-400/60">{costStr}</span>
    </span>
  )
}
