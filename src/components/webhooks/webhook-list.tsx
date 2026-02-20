'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'

function webhookUrl(id: string): string {
  if (typeof window === 'undefined') return `/api/webhooks/${id}`
  return `${window.location.origin}/api/webhooks/${id}`
}

function formatEvents(events: string[] | undefined): string {
  const list = Array.isArray(events) ? events.filter(Boolean) : []
  if (list.length === 0) return 'all events'
  if (list.length <= 2) return list.join(', ')
  return `${list.slice(0, 2).join(', ')}, +${list.length - 2}`
}

export function WebhookList({ inSidebar }: { inSidebar?: boolean }) {
  const webhooks = useAppStore((s) => s.webhooks)
  const loadWebhooks = useAppStore((s) => s.loadWebhooks)
  const setWebhookSheetOpen = useAppStore((s) => s.setWebhookSheetOpen)
  const setEditingWebhookId = useAppStore((s) => s.setEditingWebhookId)
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    loadWebhooks()
    loadAgents()
  }, [loadWebhooks, loadAgents])

  const list = useMemo(
    () => Object.values(webhooks).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    [webhooks]
  )

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(key)
      setTimeout(() => setCopied((prev) => (prev === key ? null : prev)), 1400)
    } catch {
      // ignore clipboard failures (e.g. unsupported environment)
    }
  }

  if (!list.length) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 text-center">
        <div className="w-12 h-12 rounded-[14px] bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-4">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3">
            <path d="M22 12h-4l-3 7L9 5l-3 7H2" />
          </svg>
        </div>
        <p className="text-[13px] text-text-3 mb-1 font-600">No webhooks yet</p>
        <p className="text-[12px] text-text-3/60">Create inbound endpoints to trigger agent runs</p>
        <button
          onClick={() => {
            setEditingWebhookId(null)
            setWebhookSheetOpen(true)
          }}
          className="mt-3 text-[13px] text-accent-bright hover:underline cursor-pointer bg-transparent border-none"
        >
          + Add Webhook
        </button>
      </div>
    )
  }

  return (
    <div className={`flex-1 overflow-y-auto ${inSidebar ? 'pb-10' : 'pb-20'}`}>
      {list.map((hook) => {
        const agentName = hook.agentId ? agents[hook.agentId]?.name : null
        const endpoint = webhookUrl(hook.id)
        const copiedEndpoint = copied === `endpoint:${hook.id}`
        const copiedSecret = copied === `secret:${hook.id}`
        const hasSecret = typeof hook.secret === 'string' && hook.secret.trim().length > 0

        return (
          <div
            key={hook.id}
            className="w-full flex items-center gap-2.5 px-5 py-3 hover:bg-white/[0.02] transition-colors group"
          >
            <button
              onClick={() => {
                setEditingWebhookId(hook.id)
                setWebhookSheetOpen(true)
              }}
              className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer bg-transparent border-none text-left p-0"
            >
              <div className={`shrink-0 w-9 h-9 rounded-[10px] border flex items-center justify-center ${
                hook.isEnabled
                  ? 'bg-emerald-500/12 border-emerald-500/20 text-emerald-300'
                  : 'bg-white/[0.03] border-white/[0.08] text-text-3'
              }`}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M22 12h-4l-3 7L9 5l-3 7H2" />
                </svg>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-600 text-text truncate">{hook.name || 'Unnamed Webhook'}</span>
                  <span className={`shrink-0 w-2 h-2 rounded-full ${hook.isEnabled ? 'bg-emerald-400' : 'bg-white/20'}`} />
                </div>
                <div className="text-[11px] text-text-3 truncate">
                  {hook.source || 'custom'} · {formatEvents(hook.events)}{agentName ? ` · ${agentName}` : ''}
                </div>
              </div>
            </button>

            <button
              onClick={(e) => {
                e.stopPropagation()
                copyText(`endpoint:${hook.id}`, endpoint)
              }}
              title={copiedEndpoint ? 'Copied endpoint' : 'Copy endpoint URL'}
              className={`shrink-0 w-8 h-8 rounded-[8px] flex items-center justify-center transition-all cursor-pointer border-none ${
                copiedEndpoint
                  ? 'opacity-100 bg-emerald-500/15 text-emerald-300'
                  : 'opacity-0 group-hover:opacity-100 focus:opacity-100 bg-accent-soft/40 text-accent-bright hover:bg-accent-soft'
              }`}
            >
              {copiedEndpoint ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>

            {hasSecret && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  copyText(`secret:${hook.id}`, hook.secret!.trim())
                }}
                title={copiedSecret ? 'Copied secret' : 'Copy secret'}
                className={`shrink-0 w-8 h-8 rounded-[8px] flex items-center justify-center transition-all cursor-pointer border-none ${
                  copiedSecret
                    ? 'opacity-100 bg-emerald-500/15 text-emerald-300'
                    : 'opacity-0 group-hover:opacity-100 focus:opacity-100 bg-white/[0.04] text-text-2 hover:bg-white/[0.08]'
                }`}
              >
                {copiedSecret ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                )}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
