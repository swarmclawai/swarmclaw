'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  compactChat,
  fetchContextStatus,
  type ContextStatusResponse,
} from '@/lib/chat/chats'
import { useWs } from '@/hooks/use-ws'
import { errorMessage } from '@/lib/shared-utils'

interface Props {
  sessionId: string
  messageCount: number
  onCompactComplete: () => void
  onClearRequest: () => void
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${n}`
}

function resolveColor(strategy: ContextStatusResponse['strategy']): {
  dot: string
  text: string
  border: string
  bg: string
} {
  if (strategy === 'critical') {
    return {
      dot: 'bg-red-400',
      text: 'text-red-300',
      border: 'border-red-500/25',
      bg: 'bg-red-500/10',
    }
  }
  if (strategy === 'warning') {
    return {
      dot: 'bg-amber-400',
      text: 'text-amber-300',
      border: 'border-amber-500/25',
      bg: 'bg-amber-500/10',
    }
  }
  return {
    dot: 'bg-emerald-400/80',
    text: 'text-text-3/70',
    border: 'border-white/[0.06]',
    bg: 'bg-white/[0.03]',
  }
}

export function ContextMeterBadge({ sessionId, messageCount, onCompactComplete, onClearRequest }: Props) {
  const [status, setStatus] = useState<ContextStatusResponse | null>(null)
  const [open, setOpen] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const loadStatus = useCallback(async () => {
    try {
      const next = await fetchContextStatus(sessionId)
      setStatus(next)
    } catch {
      // silent — badge just won't render
    }
  }, [sessionId])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus, messageCount])

  useWs(`messages:${sessionId}`, loadStatus)

  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent) => {
      const target = event.target as Node
      if (anchorRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open])

  const handleCompact = useCallback(async () => {
    if (compacting) return
    setCompacting(true)
    try {
      const result = await compactChat(sessionId)
      if (result.status === 'no_action') {
        toast('Nothing to compact yet.')
      } else {
        toast.success(
          `Compacted ${result.prunedCount ?? 0} message${result.prunedCount === 1 ? '' : 's'}.`,
        )
      }
      onCompactComplete()
      await loadStatus()
      setOpen(false)
    } catch (err) {
      toast.error(`Compact failed: ${errorMessage(err)}`)
    } finally {
      setCompacting(false)
    }
  }, [compacting, loadStatus, onCompactComplete, sessionId])

  const handleClearClick = useCallback(() => {
    setOpen(false)
    onClearRequest()
  }, [onClearRequest])

  if (!status) return null
  const colors = resolveColor(status.strategy)
  const percent = Math.min(100, Math.max(0, status.percentUsed))

  return (
    <div className="relative" ref={anchorRef}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`inline-flex items-center gap-1.5 rounded-[9px] border px-2.5 py-1 text-[10px] font-600 transition-colors shrink-0 cursor-pointer ${colors.bg} ${colors.border} ${colors.text} hover:border-white/[0.15] hover:text-text-2`}
        title={`${status.effectiveTokens.toLocaleString()} of ${status.contextWindow.toLocaleString()} tokens used`}
        aria-expanded={open}
        aria-label={`Context usage ${percent}%. Click for details.`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
        <span>{percent}%</span>
        <span className="text-text-3/45 font-500">
          {formatTokens(status.effectiveTokens)}
        </span>
      </button>
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-[calc(100%+6px)] z-50 w-[280px] rounded-[14px] border border-white/[0.08] bg-raised/95 p-3 shadow-[0_16px_64px_rgba(0,0,0,0.6)] backdrop-blur-xl"
          style={{ animation: 'fade-in 0.15s cubic-bezier(0.16, 1, 0.3, 1)' }}
        >
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] font-600 uppercase tracking-wider text-text-3/60">Context window</span>
            <span className={`text-[11px] font-600 ${colors.text}`}>{percent}%</span>
          </div>
          <div className="mt-2 h-1.5 w-full rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                status.strategy === 'critical' ? 'bg-red-400'
                : status.strategy === 'warning' ? 'bg-amber-400'
                : 'bg-emerald-400/80'
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <dl className="mt-3 space-y-1 text-[11px]">
            <div className="flex justify-between">
              <dt className="text-text-3/60">Used</dt>
              <dd className="text-text-2 font-mono">
                {status.effectiveTokens.toLocaleString()} / {status.contextWindow.toLocaleString()}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-3/60">Remaining</dt>
              <dd className="text-text-2 font-mono">{status.remainingTokens.toLocaleString()}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-3/60">Messages</dt>
              <dd className="text-text-2 font-mono">{status.messageCount}</dd>
            </div>
          </dl>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={handleCompact}
              disabled={compacting || status.messageCount < 3}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-[10px] border border-accent-bright/25 bg-accent-soft/40 px-2.5 py-1.5 text-[11px] font-600 text-accent-bright transition-colors hover:border-accent-bright/40 hover:bg-accent-soft/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {compacting ? (
                <>
                  <span className="w-3 h-3 rounded-full border-2 border-accent-bright/30 border-t-accent-bright animate-spin" />
                  Compacting
                </>
              ) : (
                <>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 14h6v6" />
                    <path d="M20 10h-6V4" />
                    <path d="M14 10 21 3" />
                    <path d="M3 21l7-7" />
                  </svg>
                  Compact
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleClearClick}
              className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-600 text-text-2 transition-colors hover:border-red-500/25 hover:bg-red-500/10 hover:text-red-300"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
              </svg>
              Clear
            </button>
          </div>
          <p className="mt-2.5 text-[10px] leading-relaxed text-text-3/55">
            Long-term memory, skills, and facts are preserved. Clear only affects this chat transcript.
          </p>
        </div>
      )}
    </div>
  )
}
