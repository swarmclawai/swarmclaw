'use client'

import { useState, useRef } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { useChatroomStore } from '@/stores/use-chatroom-store'
import { api } from '@/lib/api-client'
import { TOOL_LABELS } from '@/lib/tool-definitions'

interface Props {
  agentId: string
  agentName: string
  text: string
  toolOutputs?: string[]
}

export function ChatroomToolRequestBanner({ agentId, agentName, text, toolOutputs = [] }: Props) {
  const loadAgents = useAppStore((s) => s.loadAgents)
  const agents = useAppStore((s) => s.agents)
  const [granted, setGranted] = useState<Set<string>>(new Set())
  const [denied, setDenied] = useState<Set<string>>(new Set())
  const continueSentRef = useRef(false)

  const toolRequests: { toolId: string; reason: string }[] = []
  const seen = new Set<string>()

  function extractFromText(t: string) {
    try {
      const jsonMatches = t.match(/\{"type"\s*:\s*"tool_request"[^}]*\}/g)
      if (jsonMatches) {
        for (const jm of jsonMatches) {
          const parsed = JSON.parse(jm)
          if (parsed.type === 'tool_request' && parsed.toolId && !seen.has(parsed.toolId)) {
            seen.add(parsed.toolId)
            toolRequests.push({ toolId: parsed.toolId, reason: parsed.reason || '' })
          }
        }
      }
    } catch { /* ignore */ }
  }

  extractFromText(text)
  for (const output of toolOutputs) extractFromText(output)

  if (toolRequests.length === 0) return null

  const agent = agents[agentId]
  const agentTools: string[] = agent?.plugins || []

  const handleGrant = async (toolId: string) => {
    if (agentTools.includes(toolId)) {
      setGranted((prev) => new Set(prev).add(toolId))
      return
    }
    const updated = [...agentTools, toolId]
    await api('PUT', `/agents/${agentId}`, { plugins: updated })
    await loadAgents()
    const newGranted = new Set(granted).add(toolId)
    setGranted(newGranted)

    // Auto-continue: once all requested tools are granted, send @mention to continue
    const allGranted = toolRequests.every(
      (r) => newGranted.has(r.toolId) || updated.includes(r.toolId),
    )
    if (allGranted && !continueSentRef.current) {
      continueSentRef.current = true
      setTimeout(() => {
        const { streaming, sendMessage } = useChatroomStore.getState()
        if (!streaming) {
          sendMessage(`@${agentName.replace(/\s+/g, '')} Continue`)
        }
      }, 300)
    }
  }

  const handleDeny = (toolId: string) => {
    setDenied((prev) => new Set(prev).add(toolId))
    const label = TOOL_LABELS[toolId] || toolId
    setTimeout(() => {
      const { streaming, sendMessage } = useChatroomStore.getState()
      if (!streaming) {
        sendMessage(`@${agentName.replace(/\s+/g, '')} Tool access denied for ${label} — proceed without it.`)
      }
    }, 200)
  }

  return (
    <div className="max-w-[85%] flex flex-col gap-2 mt-2">
      {toolRequests.map(({ toolId, reason }) => {
        const isGranted = granted.has(toolId) || agentTools.includes(toolId)
        const isDenied = denied.has(toolId)
        const label = TOOL_LABELS[toolId] || toolId
        return (
          <div
            key={toolId}
            className="flex items-center gap-3 px-4 py-3 rounded-[12px] border border-amber-500/20 bg-amber-500/[0.06]"
            style={{ animation: 'fade-in 0.2s ease' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-amber-400 shrink-0">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] text-text-2 font-600">
                <span className="text-accent-bright">{agentName}</span> requesting <span className="text-amber-400">{label}</span>
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
                  onClick={() => handleGrant(toolId)}
                  className="px-3 py-1.5 rounded-[8px] bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-[11px] font-600 border-none cursor-pointer transition-colors"
                  style={{ fontFamily: 'inherit' }}
                >
                  Grant
                </button>
                <button
                  onClick={() => handleDeny(toolId)}
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
