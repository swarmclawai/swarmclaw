'use client'

import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useChatroomStore } from '@/stores/use-chatroom-store'
import type { StreamingAgent } from '@/stores/use-chatroom-store'
import { useAppStore } from '@/stores/use-app-store'
import { useNavigate } from '@/lib/app/navigation'
import { useNow } from '@/hooks/use-now'
import { useWs } from '@/hooks/use-ws'
import { api } from '@/lib/app/api-client'
import { resolveChatroomSyntheticSessionId } from '@/lib/chatroom-sessions'
import { ChatroomMessageBubble } from './chatroom-message'
import { ChatroomInput } from './chatroom-input'
import { ChatroomTypingBar } from './chatroom-typing-bar'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { HeartbeatMoment, ActivityMoment, isNotableTool } from '@/components/chat/activity-moment'
import { BottomSheet } from '@/components/shared/bottom-sheet'
import {
  StructuredSessionLauncher,
  type StructuredSessionLaunchContext,
} from '@/components/protocols/structured-session-launcher'
import type { Chatroom, ChatroomMessage, ChatroomMember, Agent, ProtocolRun, Session, Message } from '@/types'

function getRoleBadge(role: string) {
  if (role === 'admin') return { label: 'Admin', className: 'bg-purple-500/20 text-purple-400 border-purple-500/30' }
  if (role === 'moderator') return { label: 'Mod', className: 'bg-blue-500/20 text-blue-400 border-blue-500/30' }
  return null
}

function getMemberFromChatroom(chatroom: Chatroom, agentId: string): ChatroomMember | undefined {
  if (chatroom.members?.length) return chatroom.members.find((m) => m.agentId === agentId)
  return undefined
}

function getMemberRole(chatroom: Chatroom, agentId: string): string {
  const member = getMemberFromChatroom(chatroom, agentId)
  return member?.role || 'member'
}

function isAgentMuted(chatroom: Chatroom, agentId: string, now: number | null): boolean {
  const member = getMemberFromChatroom(chatroom, agentId)
  if (!member?.mutedUntil) return false
  return !!now && new Date(member.mutedUntil).getTime() > now
}

type MomentType = { kind: 'heartbeat' } | { kind: 'tool'; name: string; input: string }
type SessionExecLogEntry = {
  id: string
  category: string
  summary: string
  detail: Record<string, unknown> | null
  ts: number
}

function useAgentHeartbeat(agentId: string, onPulse: (id: string) => void) {
  const topic = agentId ? `heartbeat:agent:${agentId}` : ''
  const onPulseRef = useRef(onPulse)
  useEffect(() => {
    onPulseRef.current = onPulse
  }, [onPulse])
  useWs(topic, () => onPulseRef.current(agentId))
}

function AgentHeartbeatListener({ agentId, onPulse }: { agentId: string; onPulse: (id: string) => void }) {
  useAgentHeartbeat(agentId, onPulse)
  return null
}

function AgentHeartbeatListeners({ agentIds, onPulse }: { agentIds: string[]; onPulse: (id: string) => void }) {
  return (
    <>
      {agentIds.map((agentId) => (
        <AgentHeartbeatListener key={agentId} agentId={agentId} onPulse={onPulse} />
      ))}
    </>
  )
}

const GROUP_THRESHOLD_MS = 2 * 60 * 1000

function dayLabel(ts: number, now: number | null): string {
  const d = new Date(ts)
  if (!now) return d.toISOString().slice(0, 10)
  const nowDate = new Date(now)
  const today = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate())
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diff = today.getTime() - msgDay.getTime()
  if (diff === 0) return 'Today'
  if (diff === 86400000) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

export function ChatroomView() {
  const router = useRouter()
  const navigateTo = useNavigate()
  const navigateToAgent = (agentId: string) => navigateTo('agents', agentId)
  const now = useNow()
  const currentChatroomId = useChatroomStore((s) => s.currentChatroomId)
  const chatrooms = useChatroomStore((s) => s.chatrooms)
  const streamingAgents = useChatroomStore((s) => s.streamingAgents)
  const sendMessage = useChatroomStore((s) => s.sendMessage)
  const toggleReaction = useChatroomStore((s) => s.toggleReaction)
  const togglePin = useChatroomStore((s) => s.togglePin)
  const setReplyingTo = useChatroomStore((s) => s.setReplyingTo)
  const loadChatroomById = useChatroomStore((s) => s.loadChatroomById)
  const setChatroomSheetOpen = useChatroomStore((s) => s.setChatroomSheetOpen)
  const setEditingChatroomId = useChatroomStore((s) => s.setEditingChatroomId)
  const deleteMessage = useChatroomStore((s) => s.deleteMessage)
  const muteAgent = useChatroomStore((s) => s.muteAgent)
  const unmuteAgent = useChatroomStore((s) => s.unmuteAgent)
  const setMemberRole = useChatroomStore((s) => s.setMemberRole)
  const agents = useAppStore((s) => s.agents) as Record<string, Agent>
  const lastReadTimestamps = useAppStore((s) => s.lastReadTimestamps)
  const markChatRead = useAppStore((s) => s.markChatRead)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pinsExpanded, setPinsExpanded] = useState(false)
  const [isNearBottom, setIsNearBottom] = useState(true)
  const [agentMoments, setAgentMoments] = useState<Record<string, MomentType>>({})
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [structuredSessionOpen, setStructuredSessionOpen] = useState(false)
  const [structuredSessionVariant, setStructuredSessionVariant] = useState<'default' | 'breakout'>('default')
  const [structuredSessionContext, setStructuredSessionContext] = useState<StructuredSessionLaunchContext | null>(null)
  const [injectContextOpen, setInjectContextOpen] = useState(false)
  const [injectContext, setInjectContext] = useState('')
  const [injectPending, setInjectPending] = useState(false)
  const [injectError, setInjectError] = useState<string | null>(null)
  const [linkedRun, setLinkedRun] = useState<ProtocolRun | null>(null)
  const [activeParentRun, setActiveParentRun] = useState<ProtocolRun | null>(null)
  const [inspectSessionOpen, setInspectSessionOpen] = useState(false)
  const [inspectedAgent, setInspectedAgent] = useState<Agent | null>(null)
  const [inspectedSessionId, setInspectedSessionId] = useState<string | null>(null)
  const [inspectedMessages, setInspectedMessages] = useState<Message[]>([])
  const [inspectedExecLogs, setInspectedExecLogs] = useState<SessionExecLogEntry[]>([])
  const [inspectLoading, setInspectLoading] = useState(false)
  const [inspectError, setInspectError] = useState<string | null>(null)

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
  const chatroomMessages = chatroom?.messages
  const prevToolKeysRef = useRef<Record<string, string>>({})

  useEffect(() => {
    if (!chatroomMessages?.length) return
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
    if (!currentChatroomId) return
    void loadChatroomById(currentChatroomId)
  }, [currentChatroomId, loadChatroomById])

  useWs(currentChatroomId ? `chatroom:${currentChatroomId}` : '', refreshChatroom)

  const memberAgents = useMemo(() => (
    chatroom
      ? (chatroom.agentIds.map((id) => agents[id]).filter(Boolean) as Agent[])
      : []
  ), [agents, chatroom])

  const streamingAgentIds = useMemo(() => new Set(streamingAgents.keys()), [streamingAgents])
  const chatroomId = chatroom?.id || null
  const isStructuredSessionRoom = chatroom?.hidden === true && !!chatroom?.protocolRunId
  const pinnedIds = useMemo(() => chatroom?.pinnedMessageIds ?? [], [chatroom?.pinnedMessageIds])
  const pinnedMessages = useMemo(() => (
    chatroom
      ? (pinnedIds.map((pid) => chatroom.messages.find((m) => m.id === pid)).filter(Boolean) as ChatroomMessage[])
      : []
  ), [chatroom, pinnedIds])
  const memberAgentIds = chatroom?.agentIds || []
  const mutedCount = chatroom ? chatroom.agentIds.filter((agentId) => isAgentMuted(chatroom, agentId, now)).length : 0
  const adminCount = chatroom ? chatroom.agentIds.filter((agentId) => getMemberRole(chatroom, agentId) === 'admin').length : 0
  const lastReadAt = chatroom ? (lastReadTimestamps[chatroom.id] || 0) : 0
  const defaultStructuredSessionContext = useMemo<StructuredSessionLaunchContext | null>(() => {
    if (!chatroom) return null
    return {
      parentChatroomId: chatroom.id,
      parentChatroomLabel: chatroom.name,
      participantAgentIds: chatroom.agentIds || [],
      facilitatorAgentId: chatroom.agentIds?.[0] || null,
      title: `Structured session: ${chatroom.name}`,
      goal: chatroom.description || null,
    }
  }, [chatroom])
  const unreadCount = useMemo(() => (
    chatroom
      ? chatroom.messages.filter((msg) => msg.senderId !== 'user' && msg.senderId !== 'system' && (msg.time || 0) > lastReadAt).length
      : 0
  ), [chatroom, lastReadAt])

  const focusMessage = useCallback((messageId: string) => {
    const el = document.getElementById(`chatroom-msg-${messageId}`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('bg-accent-soft/20')
      setTimeout(() => el.classList.remove('bg-accent-soft/20'), 2000)
    }
  }, [])

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const node = scrollRef.current
    if (!node || !chatroom) return
    node.scrollTo({ top: node.scrollHeight, behavior })
    markChatRead(chatroom.id)
  }, [chatroom, markChatRead])

  useEffect(() => {
    if (!chatroomId) return
    markChatRead(chatroomId)
  }, [chatroomId, markChatRead])

  useEffect(() => {
    setDetailsOpen(false)
    setInspectSessionOpen(false)
    setInspectError(null)
  }, [chatroomId])

  const refreshLinkedRun = useCallback(() => {
    if (!chatroom?.protocolRunId) {
      setLinkedRun(null)
      return
    }
    void api<{ run: ProtocolRun }>('GET', `/protocols/runs/${chatroom.protocolRunId}`)
      .then((detail) => {
        setLinkedRun(detail?.run || null)
        setInjectError(null)
      })
      .catch(() => {
        setLinkedRun(null)
      })
  }, [chatroom?.protocolRunId])

  useEffect(() => {
    void refreshLinkedRun()
  }, [refreshLinkedRun])

  useWs(chatroom?.protocolRunId ? 'protocol_runs' : '', refreshLinkedRun, 2000)

  const refreshParentRun = useCallback(() => {
    if (!chatroom?.id || isStructuredSessionRoom) {
      setActiveParentRun(null)
      return
    }
    void api<ProtocolRun[]>(`GET`, `/protocols/runs?parentChatroomId=${encodeURIComponent(chatroom.id)}&limit=6`)
      .then((runs) => {
        const active = (Array.isArray(runs) ? runs : []).find((run) => !['completed', 'failed', 'cancelled', 'archived'].includes(run.status))
        setActiveParentRun(active || null)
      })
      .catch(() => setActiveParentRun(null))
  }, [chatroom?.id, isStructuredSessionRoom])

  useEffect(() => {
    void refreshParentRun()
  }, [refreshParentRun])

  useWs(!chatroom?.protocolRunId && chatroom?.id ? 'protocol_runs' : '', refreshParentRun, 2000)

  useEffect(() => {
    const node = scrollRef.current
    if (!node || !chatroomId) return
    const handleScroll = () => {
      const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120
      setIsNearBottom(nearBottom)
      if (nearBottom) markChatRead(chatroomId)
    }
    handleScroll()
    node.addEventListener('scroll', handleScroll)
    return () => node.removeEventListener('scroll', handleScroll)
  }, [chatroomId, markChatRead])

  useEffect(() => {
    if (chatroom && isNearBottom) {
      scrollToLatest(chatroom.messages.length <= 1 ? 'auto' : 'smooth')
    }
  }, [chatroom, isNearBottom, scrollToLatest, streamingAgents.size])

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
    const msg = chatroom.messages.find((m) => m.id === messageId)
    const targetAgent = agents[targetAgentId]
    if (!msg || !targetAgent) return
    const truncated = msg.text.length > 120 ? msg.text.slice(0, 120) + '...' : msg.text
    sendMessage(`@${targetAgent.name.replace(/\s+/g, '')} [Transferred from @${msg.senderName.replace(/\s+/g, '')}]: "${truncated}"`)
  }

  const handleInjectContext = async () => {
    if (!chatroom?.protocolRunId || !injectContext.trim()) return
    setInjectPending(true)
    try {
      await api('POST', `/protocols/runs/${chatroom.protocolRunId}/actions`, {
        action: 'inject_context',
        context: injectContext.trim(),
      })
      setInjectContext('')
      setInjectContextOpen(false)
      setInjectError(null)
      void Promise.all([refreshLinkedRun(), refreshChatroom()])
    } catch (error) {
      setInjectError(error instanceof Error ? error.message : 'Unable to inject context into the structured session.')
    } finally {
      setInjectPending(false)
    }
  }

  const handleInspectAgentSession = async (agent: Agent) => {
    if (!chatroom) return
    const sessionId = resolveChatroomSyntheticSessionId(chatroom.id, agent.id)
    setInspectSessionOpen(true)
    setInspectedAgent(agent)
    setInspectedSessionId(sessionId)
    setInspectLoading(true)
    setInspectError(null)

    try {
      const session = await api<Session>('GET', `/chats/${encodeURIComponent(sessionId)}`)
      setInspectedMessages(Array.isArray(session?.messages) ? session.messages : [])
      const logs = await api<SessionExecLogEntry[]>('GET', `/chats/${encodeURIComponent(sessionId)}/execution-log?limit=200`)
      setInspectedExecLogs(Array.isArray(logs) ? logs : [])
    } catch (error) {
      setInspectedMessages([])
      setInspectedExecLogs([])
      setInspectError(error instanceof Error ? error.message : 'Unable to load this agent session yet.')
    } finally {
      setInspectLoading(false)
    }
  }

  return (
    <div className="flex-1 flex min-h-0 min-w-0">
      <div className="min-w-0 flex-1 flex flex-col h-full">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06] shrink-0">
          <div className="w-8 h-8 rounded-full bg-accent-soft flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-bright">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-[14px] font-700 text-text truncate">{chatroom.name}</h3>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <p className="text-[11px] text-text-3 truncate">
                {isStructuredSessionRoom
                  ? `Temporary live room${linkedRun?.title ? ` · ${linkedRun.title}` : ''}`
                  : `${memberAgents.length} agent${memberAgents.length !== 1 ? 's' : ''}${chatroom.description ? ` · ${chatroom.description}` : ''}`}
              </p>
              {isStructuredSessionRoom && linkedRun && (
                <span className="px-1.5 py-0.5 rounded-[5px] bg-sky-500/10 text-[10px] font-700 uppercase tracking-[0.08em] text-sky-300">
                  {linkedRun.status}
                </span>
              )}
              <span className="px-1.5 py-0.5 rounded-[5px] bg-white/[0.04] text-[10px] font-700 uppercase tracking-[0.08em] text-text-3/70">
                {isStructuredSessionRoom ? 'Structured Session' : chatroom.chatMode === 'parallel' ? 'Parallel' : 'Sequential'}
              </span>
              {!isStructuredSessionRoom && (
                <span className={`px-1.5 py-0.5 rounded-[5px] text-[10px] font-700 uppercase tracking-[0.08em] ${
                  chatroom.autoAddress ? 'bg-emerald-500/10 text-emerald-400' : 'bg-white/[0.04] text-text-3/70'
                }`}>
                  Auto-address {chatroom.autoAddress ? 'on' : 'off'}
                </span>
              )}
              {streamingAgents.size > 0 && (
                <span className="px-1.5 py-0.5 rounded-[5px] bg-sky-500/10 text-[10px] font-700 uppercase tracking-[0.08em] text-sky-400">
                  {streamingAgents.size} active now
                </span>
              )}
            </div>
          </div>

          <div className="flex -space-x-1.5 shrink-0">
            {memberAgents.slice(0, 5).map((agent) => {
              const role = getMemberRole(chatroom, agent.id)
              const badge = getRoleBadge(role)
              const muted = isAgentMuted(chatroom, agent.id, Date.now())
              return (
                <Tooltip key={agent.id}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => {
                        if (streamingAgents.has(agent.id)) {
                          void handleInspectAgentSession(agent)
                          return
                        }
                        navigateToAgent(agent.id)
                      }}
                      className={`relative transition-all duration-200 hover:scale-110 hover:z-10 hover:-translate-y-0.5 cursor-pointer bg-transparent border-none p-0 ${muted ? 'opacity-40' : ''}`}
                    >
                      <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={22} status={streamingAgents.has(agent.id) ? 'busy' : 'online'} />
                      {badge && (
                        <span className={`absolute -bottom-1 -right-1 text-[7px] font-700 px-0.5 rounded border ${badge.className}`}>
                          {badge.label[0]}
                        </span>
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    <div className="flex items-center gap-1.5">
                      <span>{agent.name}</span>
                      {streamingAgents.has(agent.id) && <span className="text-[9px] text-sky-300">Click to inspect</span>}
                      {badge && <span className={`text-[9px] font-600 px-1 py-0.5 rounded border ${badge.className}`}>{badge.label}</span>}
                      {muted && <span className="text-[9px] text-red-400">Muted</span>}
                    </div>
                  </TooltipContent>
                </Tooltip>
              )
            })}
            {memberAgents.length > 5 && (
              <div className="w-[22px] h-[22px] rounded-full bg-white/[0.08] flex items-center justify-center text-[9px] text-text-3">
                +{memberAgents.length - 5}
              </div>
            )}
          </div>

          {isStructuredSessionRoom ? (
            <>
              {chatroom.protocolRunId && (
                <button
                  type="button"
                  onClick={() => router.push(`/protocols?runId=${encodeURIComponent(chatroom.protocolRunId || '')}`)}
                  className="shrink-0 rounded-[9px] border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-600 text-text-2 hover:bg-white/[0.06] cursor-pointer transition-colors"
                >
                  Back to Session
                </button>
              )}
              <button
                type="button"
                onClick={() => setInjectContextOpen(true)}
                className="shrink-0 rounded-[9px] border border-sky-500/20 bg-sky-500/10 px-2.5 py-1.5 text-[11px] font-600 text-sky-100 hover:bg-sky-500/16 cursor-pointer transition-colors"
              >
                Inject Context
              </button>
            </>
          ) : (
            <>
              {activeParentRun && (
                <button
                  type="button"
                  onClick={() => router.push(`/protocols?runId=${encodeURIComponent(activeParentRun.id)}`)}
                  className="shrink-0 rounded-[9px] border border-sky-500/20 bg-sky-500/10 px-2.5 py-1.5 text-[11px] font-600 text-sky-100 hover:bg-sky-500/16 cursor-pointer transition-colors"
                >
                  Watch Session
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setStructuredSessionVariant('default')
                  setStructuredSessionContext(defaultStructuredSessionContext)
                  setStructuredSessionOpen(true)
                }}
                className="shrink-0 rounded-[9px] border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-600 text-text-2 hover:bg-white/[0.06] cursor-pointer transition-colors"
              >
                Start Session
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => setDetailsOpen(true)}
            className="xl:hidden shrink-0 rounded-[9px] border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-600 text-text-2 hover:bg-white/[0.06] cursor-pointer transition-colors"
          >
            Details
          </button>

          {!isStructuredSessionRoom && (
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
          )}
        </div>

        {isStructuredSessionRoom && (
          <div className="border-b border-white/[0.06] bg-sky-500/[0.04] px-4 py-3">
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-sky-100">
              <span className="font-700 uppercase tracking-[0.08em] text-sky-200/72">Watching Live Room</span>
              {linkedRun?.title && <span className="text-text-2">· {linkedRun.title}</span>}
            </div>
            <div className="mt-1 text-[12px] text-text-3/72">
              This temporary room mirrors the active structured session. Use Inject Context to steer the run without turning this room into a normal free-form chat.
            </div>
          </div>
        )}

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
                {pinnedMessages.map((message) => (
                  <button
                    key={message.id}
                    onClick={() => focusMessage(message.id)}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-[8px] hover:bg-white/[0.04] transition-colors cursor-pointer bg-transparent border-none text-left w-full"
                    style={{ fontFamily: 'inherit' }}
                  >
                    <span className="text-[11px] font-600 text-accent-bright shrink-0">{message.senderName}</span>
                    <span className="text-[11px] text-text-3 truncate flex-1">{message.text.slice(0, 80)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <AgentHeartbeatListeners agentIds={memberAgentIds} onPulse={handleHeartbeatPulse} />

        <div className="relative flex-1 min-h-0">
          <div ref={scrollRef} className="absolute inset-0 overflow-y-auto py-3">
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
                const prevDay = prev ? new Date(prev.time).toDateString() : null
                const msgDay = new Date(msg.time).toDateString()
                const showDaySep = !prev || prevDay !== msgDay

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
                        <span className="text-[10px] font-600 text-text-3 uppercase tracking-wider">{dayLabel(msg.time, now)}</span>
                        <div className="flex-1 h-px bg-white/[0.06]" />
                      </div>
                    )}
                    <ChatroomMessageBubble
                      message={msg}
                      agents={agents}
                      onToggleReaction={toggleReaction}
                      onReply={(message: ChatroomMessage) => setReplyingTo(message)}
                      onTogglePin={togglePin}
                      onTransfer={handleTransfer}
                      onDeleteMessage={(messageId, targetAgentId) => deleteMessage(messageId, targetAgentId)}
                      onMuteAgent={(agentId) => muteAgent(agentId)}
                      onUnmuteAgent={(agentId) => unmuteAgent(agentId)}
                      onSetRole={(agentId, role) => setMemberRole(agentId, role)}
                      chatroom={chatroom}
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

          {(!isNearBottom || unreadCount > 0) && (
            <button
              onClick={() => scrollToLatest('smooth')}
              className="absolute bottom-4 right-4 px-3.5 py-2 rounded-[10px] bg-surface-2/95 backdrop-blur-xl border border-white/[0.1] text-[12px] font-700 text-text shadow-[0_8px_30px_rgba(0,0,0,0.4)] hover:bg-white/[0.08] transition-all cursor-pointer"
              style={{ fontFamily: 'inherit' }}
            >
              Jump to latest{unreadCount > 0 ? ` · ${unreadCount} new` : ''}
            </button>
          )}
        </div>

        {isStructuredSessionRoom && (
          <div className="border-t border-white/[0.06] bg-white/[0.02] px-4 py-2.5 text-[12px] text-text-3/68">
            Live rooms are watch-first. To steer the session, use <span className="font-700 text-text-2">Inject Context</span> instead of sending a normal room message.
          </div>
        )}

        <ChatroomInput
          agents={memberAgents}
          onSend={sendMessage}
          disabled={isStructuredSessionRoom}
          onBreakoutRequest={(context) => {
            setStructuredSessionVariant('breakout')
            setStructuredSessionContext(context)
            setStructuredSessionOpen(true)
          }}
        />
      </div>

      <aside className="hidden xl:flex xl:w-[300px] xl:flex-col xl:border-l xl:border-white/[0.06] bg-surface/30">
        <RoomDetailsPanel
          chatroom={chatroom}
          memberAgents={memberAgents}
          streamingAgents={streamingAgents}
          pinnedMessages={pinnedMessages}
          mutedCount={mutedCount}
          adminCount={adminCount}
          now={now}
          onFocusMessage={focusMessage}
          onNavigateToAgent={navigateToAgent}
          onInspectAgentSession={handleInspectAgentSession}
        />
      </aside>

      <BottomSheet open={detailsOpen} onClose={() => setDetailsOpen(false)}>
        <RoomDetailsPanel
          chatroom={chatroom}
          memberAgents={memberAgents}
          streamingAgents={streamingAgents}
          pinnedMessages={pinnedMessages}
          mutedCount={mutedCount}
          adminCount={adminCount}
          now={now}
          onFocusMessage={(messageId) => {
            setDetailsOpen(false)
            setTimeout(() => focusMessage(messageId), 50)
          }}
          onNavigateToAgent={navigateToAgent}
          onInspectAgentSession={handleInspectAgentSession}
          compact
        />
      </BottomSheet>
      <BottomSheet
        open={inspectSessionOpen}
        onClose={() => {
          setInspectSessionOpen(false)
          setInspectError(null)
        }}
        title={inspectedAgent ? `${inspectedAgent.name} session` : 'Agent session'}
        description={inspectedSessionId ? `Inspecting ${inspectedSessionId}` : 'Inspecting active chatroom member session'}
      >
        {inspectLoading ? (
          <div className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-4 py-6 text-[13px] text-text-3">
            Loading session activity…
          </div>
        ) : inspectError ? (
          <div className="rounded-[12px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-[13px] text-red-200">
            {inspectError}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                <div className="text-[16px] font-display font-700 text-text">{inspectedMessages.length}</div>
                <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-text-3/50">Messages</div>
              </div>
              <div className="rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                <div className="text-[16px] font-display font-700 text-sky-300">{inspectedExecLogs.length}</div>
                <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-text-3/50">Events</div>
              </div>
              <div className="rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                <div className="text-[12px] font-mono text-text-2 truncate" title={inspectedSessionId || undefined}>
                  {inspectedSessionId || '—'}
                </div>
                <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-text-3/50">Session ID</div>
              </div>
            </div>

            <section>
              <h4 className="mb-2 text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/60">Recent Messages</h4>
              <div className="max-h-[220px] space-y-2 overflow-y-auto rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-3">
                {inspectedMessages.length === 0 ? (
                  <p className="text-[12px] text-text-3">No messages yet for this session.</p>
                ) : (
                  inspectedMessages.slice(-12).map((message, index) => (
                    <div key={`${message.time}-${message.role}-${index}`} className="rounded-[10px] border border-white/[0.05] bg-black/20 px-3 py-2">
                      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.08em] text-text-3/60">
                        <span>{message.role}</span>
                        <span>·</span>
                        <span>{new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                      </div>
                      <p className="mt-1 text-[12px] leading-[1.5] text-text-2 whitespace-pre-wrap break-words">
                        {message.text || '(empty)'}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section>
              <h4 className="mb-2 text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/60">Execution Log</h4>
              <div className="max-h-[220px] space-y-2 overflow-y-auto rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-3">
                {inspectedExecLogs.length === 0 ? (
                  <p className="text-[12px] text-text-3">No execution log entries yet.</p>
                ) : (
                  inspectedExecLogs
                    .slice()
                    .sort((a, b) => b.ts - a.ts)
                    .map((entry) => (
                      <div key={entry.id} className="rounded-[10px] border border-white/[0.05] bg-black/20 px-3 py-2">
                        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.08em] text-text-3/60">
                          <span>{entry.category}</span>
                          <span>·</span>
                          <span>{new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                        </div>
                        <p className="mt-1 text-[12px] leading-[1.5] text-text-2 whitespace-pre-wrap break-words">
                          {entry.summary}
                        </p>
                      </div>
                    ))
                )}
              </div>
            </section>
          </div>
        )}
      </BottomSheet>
      <StructuredSessionLauncher
        open={structuredSessionOpen}
        onClose={() => {
          setStructuredSessionOpen(false)
          setStructuredSessionVariant('default')
          setStructuredSessionContext(null)
        }}
        onCreated={(run) => {
          router.push(`/protocols?runId=${encodeURIComponent(run.id)}`)
        }}
        variant={structuredSessionVariant}
        initialContext={structuredSessionContext || defaultStructuredSessionContext}
      />
      <BottomSheet
        open={injectContextOpen}
        onClose={() => {
          setInjectContextOpen(false)
          setInjectError(null)
        }}
        title="Inject Context"
        description="Add steering guidance to the active structured session without sending a normal room message."
      >
        {injectError && (
          <div className="mb-4 rounded-[12px] border border-red-500/20 bg-red-500/10 px-4 py-3 text-[13px] text-red-200">
            {injectError}
          </div>
        )}
        <textarea
          value={injectContext}
          onChange={(event) => setInjectContext(event.target.value)}
          rows={5}
          placeholder="Add a correction, tighter constraint, or something the session should focus on next."
          className="w-full rounded-[14px] border border-white/[0.06] bg-white/[0.04] px-4 py-3 text-[14px] leading-relaxed text-text outline-none placeholder:text-text-3/35"
        />
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => setInjectContextOpen(false)}
            className="rounded-[10px] border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[12px] font-700 text-text-2 cursor-pointer"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => void handleInjectContext()}
            disabled={!injectContext.trim() || injectPending}
            className="rounded-[10px] bg-accent-bright px-3 py-2 text-[12px] font-700 text-black transition-opacity disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
          >
            {injectPending ? 'Injecting…' : 'Inject Context'}
          </button>
        </div>
      </BottomSheet>
    </div>
  )
}

function RoomDetailsPanel({
  chatroom,
  memberAgents,
  streamingAgents,
  pinnedMessages,
  mutedCount,
  adminCount,
  now,
  onFocusMessage,
  onNavigateToAgent,
  onInspectAgentSession,
  compact = false,
}: {
  chatroom: Chatroom
  memberAgents: Agent[]
  streamingAgents: Map<string, StreamingAgent>
  pinnedMessages: ChatroomMessage[]
  mutedCount: number
  adminCount: number
  now: number | null
  onFocusMessage: (messageId: string) => void
  onNavigateToAgent: (agentId: string) => void
  onInspectAgentSession: (agent: Agent) => Promise<void>
  compact?: boolean
}) {
  return (
    <div className={`flex flex-col ${compact ? 'gap-5' : 'h-full'}`}>
      <div className={compact ? '' : 'border-b border-white/[0.06] px-4 py-4'}>
        <h3 className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/60">Room Status</h3>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {[
            { label: 'Members', value: String(memberAgents.length), tone: 'text-text' },
            { label: 'Active', value: String(streamingAgents.size), tone: 'text-sky-400' },
            { label: 'Pinned', value: String(pinnedMessages.length), tone: 'text-amber-400' },
            { label: 'Muted', value: String(mutedCount), tone: 'text-rose-400' },
          ].map((item) => (
            <div key={item.label} className="rounded-[10px] border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
              <div className={`text-[18px] font-display font-700 tracking-[-0.02em] ${item.tone}`}>{item.value}</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-text-3/50">{item.label}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 space-y-1 text-[11px] text-text-3/65">
          <div>Mode: {chatroom.chatMode === 'parallel' ? 'Parallel replies' : 'Sequential replies'}</div>
          <div>Auto-address: {chatroom.autoAddress ? 'Enabled' : 'Off'}</div>
          <div>Admins: {adminCount}</div>
        </div>
      </div>

      <div className={compact ? 'space-y-4' : 'flex-1 overflow-y-auto px-4 py-4 space-y-4'}>
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/60">Members</h4>
            <span className="text-[11px] text-text-3/40">{memberAgents.length}</span>
          </div>
          <div className="space-y-2">
            {memberAgents.map((agent) => {
              const role = getMemberRole(chatroom, agent.id)
              const muted = isAgentMuted(chatroom, agent.id, now)
              return (
                <button
                  key={agent.id}
                  onClick={() => {
                    if (streamingAgents.has(agent.id)) {
                      void onInspectAgentSession(agent)
                      return
                    }
                    onNavigateToAgent(agent.id)
                  }}
                  className="w-full rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-left hover:bg-white/[0.05] transition-all cursor-pointer"
                  style={{ fontFamily: 'inherit' }}
                >
                  <div className="flex items-center gap-3">
                    <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={26} status={streamingAgents.has(agent.id) ? 'busy' : 'online'} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-600 text-text">{agent.name}</div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <span className="rounded-[5px] bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-700 uppercase tracking-[0.08em] text-text-3/70">
                          {role}
                        </span>
                        {muted && (
                          <span className="rounded-[5px] bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-700 uppercase tracking-[0.08em] text-rose-400">
                            Muted
                          </span>
                        )}
                        {streamingAgents.has(agent.id) && (
                          <span className="rounded-[5px] bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-700 uppercase tracking-[0.08em] text-sky-400">
                            Active
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </section>

        {pinnedMessages.length > 0 && (
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-[12px] font-700 uppercase tracking-[0.08em] text-text-3/60">Pinned</h4>
              <span className="text-[11px] text-text-3/40">{pinnedMessages.length}</span>
            </div>
            <div className="space-y-2">
              {pinnedMessages.slice(0, compact ? pinnedMessages.length : 4).map((message) => (
                <button
                  key={message.id}
                  onClick={() => onFocusMessage(message.id)}
                  className="w-full rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-left hover:bg-white/[0.05] transition-all cursor-pointer"
                  style={{ fontFamily: 'inherit' }}
                >
                  <div className="text-[11px] font-700 text-accent-bright">{message.senderName}</div>
                  <div className="mt-1 line-clamp-2 text-[12px] text-text-3">{message.text}</div>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
