'use client'

import { useState, useRef } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { api } from '@/lib/api-client'
import { TOOL_LABELS } from '@/lib/tool-definitions'

interface Props {
  text: string
  toolOutputs?: string[]
}

export function ToolRequestBanner({ text, toolOutputs = [] }: Props) {
  const loadSessions = useAppStore((s) => s.loadSessions)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const sessions = useAppStore((s) => s.sessions)
  const serverApprovals = useAppStore((s) => s.approvals)
  const loadApprovals = useAppStore((s) => s.loadApprovals)
  const [granted, setGranted] = useState<Set<string>>(new Set())
  const [denied, setDenied] = useState<Set<string>>(new Set())
  const continueSentRef = useRef(false)

  // Resolve matching server-side tool_access approval when user grants/denies inline
  const resolveMatchingApproval = (toolId: string, approved: boolean) => {
    const match = Object.values(serverApprovals).find(
      (a) => a.status === 'pending' && a.category === 'tool_access'
        && (a.data?.toolId === toolId || a.data?.pluginId === toolId)
    )
    if (match) {
      api('POST', '/approvals', { id: match.id, approved }).then(() => loadApprovals()).catch(() => { /* best effort */ })
    }
  }

  const pluginRequests: { pluginId: string; reason: string }[] = []
  const seen = new Set<string>()

  function extractFromText(t: string) {
    try {
      const jsonMatches = t.match(/\{"type"\s*:\s*"(?:tool_request|plugin_request)"[^}]*\}/g)
      if (jsonMatches) {
        for (const jm of jsonMatches) {
          const parsed = JSON.parse(jm)
          const pluginId = parsed.pluginId || parsed.toolId
          if ((parsed.type === 'tool_request' || parsed.type === 'plugin_request') && pluginId && !seen.has(pluginId)) {
            seen.add(pluginId)
            pluginRequests.push({ pluginId, reason: parsed.reason || '' })
          }
        }
      }
    } catch { /* ignore */ }
  }

  // Scan message text and all tool outputs
  extractFromText(text)
  for (const output of toolOutputs) extractFromText(output)

  if (pluginRequests.length === 0) return null

  const sid = currentSessionId
  const session = sid ? sessions[sid] : null

  const handleGrant = async (toolId: string) => {
    if (!sid || !session) return
    const currentTools: string[] = session.plugins || []
    if (currentTools.includes(toolId)) {
      setGranted((prev) => new Set(prev).add(toolId))
      return
    }
    const updated = [...currentTools, toolId]
    await api('PUT', `/chats/${sid}`, { plugins: updated })
    await loadSessions()
    const newGranted = new Set(granted).add(toolId)
    setGranted(newGranted)

    // Resolve matching server-side approval so approvals page stays in sync
    resolveMatchingApproval(toolId, true)

    // Notify agent that access was granted with a precise message (not a vague "Continue")
    const allGranted = pluginRequests.every(
      (r) => newGranted.has(r.pluginId) || updated.includes(r.pluginId),
    )
    if (allGranted && !continueSentRef.current) {
      continueSentRef.current = true
      const grantedNames = pluginRequests.map((r) => TOOL_LABELS[r.pluginId] || r.pluginId).join(', ')
      setTimeout(() => {
        const { streaming, sendMessage } = useChatStore.getState()
        if (!streaming) {
          sendMessage(`Access granted for: ${grantedNames}. You now have these tools available — proceed with your task.`)
        }
      }, 300)
    }
  }

  const handleDeny = (toolId: string) => {
    setDenied((prev) => new Set(prev).add(toolId))
    // Resolve matching server-side approval
    resolveMatchingApproval(toolId, false)
    const label = TOOL_LABELS[toolId] || toolId
    setTimeout(() => {
      const { streaming, sendMessage } = useChatStore.getState()
      if (!streaming) {
        sendMessage(`Plugin access denied for ${label} — proceed without it.`)
      }
    }, 200)
  }

  return (
    <div className="max-w-[85%] md:max-w-[72%] flex flex-col gap-2 mt-2">
      {pluginRequests.map(({ pluginId, reason }) => {
        const isGranted = granted.has(pluginId) || (session?.plugins || []).includes(pluginId)
        const isDenied = denied.has(pluginId)
        const label = TOOL_LABELS[pluginId] || pluginId
        return (
          <div
            key={pluginId}
            className="flex items-center gap-3 px-4 py-3 rounded-[12px] border border-amber-500/20 bg-amber-500/[0.06]"
            style={{ animation: 'fade-in 0.2s ease' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-amber-400 shrink-0">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] text-text-2 font-600">
                Requesting plugin access to <span className="text-amber-400">{label}</span>
              </p>
              {reason && <p className="text-[11px] text-text-3/60 mt-0.5 truncate">{reason}</p>}
            </div>
            {isGranted ? (
              <span className="text-[11px] text-emerald-400 font-600 shrink-0">Granted</span>
            ) : isDenied ? (
              <span className="text-[11px] text-red-400 font-600 shrink-0">Denied</span>
            ) : (
              <div className="flex gap-1.5 shrink-0">
                <button
                  onClick={() => handleGrant(pluginId)}
                  className="px-3 py-1.5 rounded-[8px] bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-[11px] font-600 border-none cursor-pointer transition-colors"
                  style={{ fontFamily: 'inherit' }}
                >
                  Grant
                </button>
                <button
                  onClick={() => handleDeny(pluginId)}
                  className="px-3 py-1.5 rounded-[8px] bg-red-500/15 hover:bg-red-500/25 text-red-400 text-[11px] font-600 border-none cursor-pointer transition-colors"
                  style={{ fontFamily: 'inherit' }}
                >
                  Deny
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
