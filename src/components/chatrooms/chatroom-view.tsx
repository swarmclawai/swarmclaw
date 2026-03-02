'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { useChatroomStore } from '@/stores/use-chatroom-store'
import { useAppStore } from '@/stores/use-app-store'
import { useWs } from '@/hooks/use-ws'
import { ChatroomMessageBubble } from './chatroom-message'
import { ChatroomInput } from './chatroom-input'
import { ChatroomTypingBar } from './chatroom-typing-bar'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { HeartbeatMoment, ActivityMoment, isNotableTool } from '@/components/chat/activity-moment'
import type { Chatroom, ChatroomMessage, Agent } from '@/types'

function navigateToAgent(agentId: string) {
  useAppStore.getState().setActiveView('agents')
  useAppStore.getState().setCurrentAgent(agentId)
}

type MomentType = { kind: 'heartbeat' } | { kind: 'tool'; name: string; input: string }

/** Subscribe to a single agent heartbeat topic — one hook call per agent */
function useAgentHeartbeat(agentId: string, onPulse: (id: string) => void) {
  const topic = agentId ? `heartbeat:agent:${agentId}` : ''
  const onPulseRef = useRef(onPulse)
  useEffect(() => {
    onPulseRef.current = onPulse
  }, [onPulse])
  useWs(topic, () => onPulseRef.current(agentId))
}

/** Subscribes up to 6 member agents to heartbeat topics */
function AgentHeartbeatListeners({ agentIds, onPulse }: { agentIds: string[]; onPulse: (id: string) => void }) {
  useAgentHeartbeat(agentIds[0] || '', onPulse)
  useAgentHeartbeat(agentIds[1] || '', onPulse)
  useAgentHeartbeat(agentIds[2] || '', onPulse)
  useAgentHeartbeat(agentIds[3] || '', onPulse)
  useAgentHeartbeat(agentIds[4] || '', onPulse)
  useAgentHeartbeat(agentIds[5] || '', onPulse)
  return null
}

const GROUP_THRESHOLD_MS = 2 * 60 * 1000 // 2 minutes

function dayLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diff = today.getTime() - msgDay.getTime()
  if (diff === 0) return 'Today'
  if (diff === 86400000) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

export function ChatroomView() {
  const currentChatroomId = useChatroomStore((s) => s.currentChatroomId)
  const chatrooms = useChatroomStore((s) => s.chatrooms)
  const streaming = useChatroomStore((s) => s.streaming)
  const streamingAgents = useChatroomStore((s) => s.streamingAgents)
  const sendMessage = useChatroomStore((s) => s.sendMessage)
  const toggleReaction = useChatroomStore((s) => s.toggleReaction)
  const togglePin = useChatroomStore((s) => s.togglePin)
  const setReplyingTo = useChatroomStore((s) => s.setReplyingTo)
  const loadChatrooms = useChatroomStore((s) => s.loadChatrooms)
  const setChatroomSheetOpen = useChatroomStore((s) => s.setChatroomSheetOpen)
  const setEditingChatroomId = useChatroomStore((s) => s.setEditingChatroomId)
  const agents = useAppStore((s) => s.agents) as Record<string, Agent>
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pinsExpanded, setPinsExpanded] = useState(false)

  // Per-agent moment overlays (heartbeat or tool events)
  const [agentMoments, setAgentMoments] = useState<Record<string, MomentType>>({})

  const handleHeartbeatPulse = useCallback((agentId: string) => {
    setAgentMoments((prev) => ({ ...prev, [agentId]: { kind: 'heartbeat' } }))
  }, [])

  const clearAgentMoment = useCallback((agentId: string) => {
    setAgentMoments((prev) => {
      const next = { ...prev }
      delete next[agentId]
      return next
    })
  }, [])

  const chatroom = currentChatroomId ? (chatrooms[currentChatroomId] as Chatroom | undefined) : null

  // Detect notable tool events from chatroom messages
  const chatroomMessages = chatroom?.messages
  const prevToolKeysRef = useRef<Record<string, string>>({})
  useEffect(() => {
    if (!chatroomMessages?.length) return
    // Find the last message from each agent and check for notable tools
    const lastByAgent = new Map<string, ChatroomMessage>()
    for (const msg of chatroomMessages) {
      if (msg.senderId !== 'user' && msg.senderId !== 'system') {
        lastByAgent.set(msg.senderId, msg)
      }
    }
    for (const [agentId, msg] of lastByAgent) {
      const events = msg.toolEvents
      if (!events?.length) continue
      for (let i = events.length - 1; i >= 0; i--) {
        if (isNotableTool(events[i].name)) {
          const key = `${msg.id}-${events[i].name}-${i}`
          if (key !== prevToolKeysRef.current[agentId]) {
            prevToolKeysRef.current[agentId] = key
            setAgentMoments((prev) => ({ ...prev, [agentId]: { kind: 'tool', name: events[i].name, input: events[i].input || '' } }))
          }
          break
        }
      }
    }
  }, [chatroomMessages])

  const refreshChatroom = useCallback(() => {
    loadChatrooms()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useWs(currentChatroomId ? `chatroom:${currentChatroomId}` : '', refreshChatroom)

  // Smooth auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [chatroom?.messages.length, streamingAgents.size])

  const memberAgents = chatroom
    ? (chatroom.agentIds
      .map((id) => agents[id])
      .filter(Boolean) as Agent[])
    : []

  const streamingAgentIds = new Set(streamingAgents.keys())
  const pinnedIds = chatroom?.pinnedMessageIds || []
  const pinnedMessages = chatroom
    ? (pinnedIds.map((pid) => chatroom.messages.find((m) => m.id === pid)).filter(Boolean) as ChatroomMessage[])
    : []

  // Heartbeat subscriptions for up to 6 member agents
  const memberAgentIds = chatroom?.agentIds.slice(0, 6) || []

  if (!chatroom) {
    return (
      <div className="flex-1 flex items-center justify-center px-8">
        <div className="text-center max-w-[420px]">
          <h2 className="font-display text-[24px] font-700 text-text mb-2 tracking-[-0.02em]">
            Select a Chatroom
          </h2>
          <p className="text-[14px] text-text-3">
            Choose a chatroom from the sidebar or create a new one.
          </p>
        </div>
      </div>
    )
  }

  const handleTransfer = (messageId: string, targetAgentId: string) => {
    if (!chatroom) return
    const msg = chatroom.messages.find((m) => m.id === messageId)
    const targetAgent = agents[targetAgentId]
    if (!msg || !targetAgent) return
    const truncated = msg.text.length > 120 ? msg.text.slice(0, 120) + '...' : msg.text
    sendMessage(`@${targetAgent.name.replace(/\s+/g, '')} [Transferred from @${msg.senderName.replace(/\s+/g, '')}]: "${truncated}"`)
  }

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06] shrink-0">
        <div className="w-8 h-8 rounded-full bg-accent-soft flex items-center justify-center shrink-0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-bright">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-[14px] font-700 text-text truncate">{chatroom.name}</h3>
          <p className="text-[11px] text-text-3 truncate">
            {memberAgents.length} agent{memberAgents.length !== 1 ? 's' : ''}
            {chatroom.description ? ` · ${chatroom.description}` : ''}
          </p>
        </div>
        {/* Member avatars */}
        <div className="flex -space-x-1.5 shrink-0">
          {memberAgents.slice(0, 5).map((agent) => (
            <Tooltip key={agent.id}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => navigateToAgent(agent.id)}
                  className="relative transition-all duration-200 hover:scale-110 hover:z-10 hover:-translate-y-0.5 cursor-pointer bg-transparent border-none p-0"
                >
                  <AgentAvatar seed={agent.avatarSeed} name={agent.name} size={22} status={streamingAgents.has(agent.id) ? 'busy' : 'online'} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {agent.name}
              </TooltipContent>
            </Tooltip>
          ))}
          {memberAgents.length > 5 && (
            <div className="w-[22px] h-[22px] rounded-full bg-white/[0.08] flex items-center justify-center text-[9px] text-text-3">
              +{memberAgents.length - 5}
            </div>
          )}
        </div>
        <button
          onClick={() => {
            setEditingChatroomId(chatroom.id)
            setChatroomSheetOpen(true)
          }}
          className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/[0.08] transition-all cursor-pointer"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      {/* Pinned messages bar */}
      {pinnedMessages.length > 0 && (
        <div className="border-b border-white/[0.06] shrink-0">
          <button
            onClick={() => setPinsExpanded(!pinsExpanded)}
            className="w-full flex items-center gap-2 px-4 py-2 hover:bg-white/[0.02] transition-colors cursor-pointer bg-transparent border-none text-left"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400 shrink-0">
              <path d="M12 17v5" />
              <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 2-2H6a2 2 0 0 0 2 2 1 1 0 0 1 1 1z" />
            </svg>
            <span className="text-[12px] font-500 text-text-2">{pinnedMessages.length} pinned</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`text-text-3 transition-transform ${pinsExpanded ? 'rotate-180' : ''}`}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {pinsExpanded && (
            <div className="px-4 pb-2 flex flex-col gap-1">
              {pinnedMessages.map((pm) => (
                <button
                  key={pm.id}
                  onClick={() => {
                    const el = document.getElementById(`chatroom-msg-${pm.id}`)
                    if (el) {
                      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                      el.classList.add('bg-accent-soft/20')
                      setTimeout(() => el.classList.remove('bg-accent-soft/20'), 2000)
                    }
                  }}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-[8px] hover:bg-white/[0.04] transition-colors cursor-pointer bg-transparent border-none text-left w-full"
                  style={{ fontFamily: 'inherit' }}
                >
                  <span className="text-[11px] font-600 text-accent-bright shrink-0">{pm.senderName}</span>
                  <span className="text-[11px] text-text-3 truncate flex-1">{pm.text.slice(0, 80)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <AgentHeartbeatListeners agentIds={memberAgentIds} onPulse={handleHeartbeatPulse} />

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-3">
        {chatroom.messages.length === 0 ? (
          <div className="flex items-center justify-center h-full px-6">
            <div className="text-center">
              <p className="text-[13px] text-text-3 mb-1">No messages yet</p>
              <p className="text-[12px] text-text-3/60">Use @AgentName to mention specific agents, or @all for everyone</p>
            </div>
          </div>
        ) : (
          chatroom.messages.map((msg, i) => {
            const prev = i > 0 ? chatroom.messages[i - 1] : null
            const isGrouped = prev
              ? prev.senderId === msg.senderId && (msg.time - prev.time) < GROUP_THRESHOLD_MS
              : false
            // Day separator: show when the date changes between messages
            const prevDay = prev ? new Date(prev.time).toDateString() : null
            const msgDay = new Date(msg.time).toDateString()
            const showDaySep = !prev || prevDay !== msgDay

            // Moment overlay — show on the last message from each agent that has an active moment
            const senderId = msg.senderId
            const moment = agentMoments[senderId]
            const isLastFromSender = !chatroom.messages.slice(i + 1).some((m) => m.senderId === senderId)
            let momentOverlay: React.ReactNode = null
            if (moment && isLastFromSender && senderId !== 'user' && senderId !== 'system') {
              if (moment.kind === 'heartbeat') {
                momentOverlay = <HeartbeatMoment onDismiss={() => clearAgentMoment(senderId)} />
              } else {
                momentOverlay = (
                  <ActivityMoment
                    key={`${moment.name}-${senderId}`}
                    toolName={moment.name}
                    toolInput={moment.input}
                    onDismiss={() => clearAgentMoment(senderId)}
                  />
                )
              }
            }

            return (
              <div key={msg.id}>
                {showDaySep && (
                  <div className="flex items-center gap-3 px-4 py-3">
                    <div className="flex-1 h-px bg-white/[0.06]" />
                    <span className="text-[10px] font-600 text-text-3 uppercase tracking-wider">{dayLabel(msg.time)}</span>
                    <div className="flex-1 h-px bg-white/[0.06]" />
                  </div>
                )}
                <ChatroomMessageBubble
                  message={msg}
                  agents={agents}
                  onToggleReaction={toggleReaction}
                  onReply={(m: ChatroomMessage) => setReplyingTo(m)}
                  onTogglePin={togglePin}
                  onTransfer={handleTransfer}
                  pinnedMessageIds={pinnedIds}
                  streamingAgentIds={streamingAgentIds}
                  messages={chatroom.messages}
                  grouped={isGrouped && !showDaySep}
                  momentOverlay={momentOverlay}
                />
              </div>
            )
          })
        )}
        <ChatroomTypingBar streamingAgents={streamingAgents} />
      </div>

      {/* Input */}
      <ChatroomInput
        agents={memberAgents}
        onSend={sendMessage}
        disabled={streaming}
      />
    </div>
  )
}
