'use client'

import { useEffect } from 'react'
import { useParams } from 'next/navigation'
import { useAppStore } from '@/stores/use-app-store'
import { ChatArea } from '@/components/chat/chat-area'

export default function AgentChatPage() {
  const { id } = useParams<{ id: string }>()
  const setCurrentAgent = useAppStore((s) => s.setCurrentAgent)

  // Sync URL param to store
  useEffect(() => {
    if (id) {
      void setCurrentAgent(decodeURIComponent(id))
    }
  }, [id, setCurrentAgent])

  return (
    <div className="flex-1 flex h-full min-h-0 min-w-0">
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <ChatArea key={id} />
      </div>
    </div>
  )
}
