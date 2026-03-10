'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { useAppStore } from '@/stores/use-app-store'
import { selectActiveSessionId } from '@/stores/slices/session-slice'
import { ChatArea } from '@/components/chat/chat-area'
import { CanvasPanel } from '@/components/canvas/canvas-panel'

export default function AgentChatPage() {
  const { id } = useParams<{ id: string }>()
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)
  const activeSessionId = useAppStore(selectActiveSessionId)
  const sessions = useAppStore((s) => s.sessions)
  const agents = useAppStore((s) => s.agents)
  const [canvasDismissedFor, setCanvasDismissedFor] = useState<string | null>(null)

  // Sync URL param to store
  useEffect(() => {
    if (id) {
      void setCurrentAgent(decodeURIComponent(id))
    }
  }, [id, setCurrentAgent])

  const currentSession = activeSessionId ? sessions[activeSessionId] : null
  const hasCanvas = !!(currentSession?.canvasContent && canvasDismissedFor !== activeSessionId)
  const canvasAgentName = currentSession?.agentId && agents[currentSession.agentId] ? agents[currentSession.agentId].name : undefined

  return (
    <div className="flex-1 flex h-full min-h-0 min-w-0">
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <ChatArea key={id} />
      </div>
      {hasCanvas && activeSessionId && (
        <CanvasPanel
          sessionId={activeSessionId}
          agentName={canvasAgentName}
          onClose={() => activeSessionId && setCanvasDismissedFor(activeSessionId)}
        />
      )}
    </div>
  )
}
