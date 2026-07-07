'use client'

import { useState } from 'react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { useNow } from '@/hooks/use-now'
import { ReactionPicker } from './reaction-picker'
import { ReplyQuote } from '@/components/shared/reply-quote'
import { MarkdownBody } from '@/components/shared/markdown-body'
import { MessageAttachments } from '@/components/shared/attachment-chip'
import { MessageActions, ActionButton } from '@/components/shared/message-actions'
import { isStructuredMarkdown } from '@/components/shared/markdown-utils'
import { useAppStore } from '@/stores/use-app-store'
import { useNavigate } from '@/lib/app/navigation'
import { AgentHoverCard } from './agent-hover-card'
import { ChatroomToolRequestBanner } from './chatroom-tool-request-banner'
import { ToolActivityPill, ToolEventsSection } from '@/components/chat/tool-events-section'
import { TransferAgentPicker } from '@/components/chat/transfer-agent-picker'
import { ConnectorPlatformIcon, getConnectorPlatformLabel } from '@/components/shared/connector-platform-icon'
import type { ChatroomMessage, Chatroom, Agent } from '@/types'

interface Props {
  message: ChatroomMessage
  agents: Record<string, Agent>
  onToggleReaction: (messageId: string, emoji: string) => void
  onReply?: (message: ChatroomMessage) => void
  onTogglePin?: (messageId: string) => void
  onTransfer?: (messageId: string, targetAgentId: string) => void
  onDeleteMessage?: (messageId: string, targetAgentId: string) => void
  onMuteAgent?: (agentId: string) => void
  onUnmuteAgent?: (agentId: string) => void
  onSetRole?: (agentId: string, role: 'admin' | 'moderator' | 'member') => void
  chatroom?: Chatroom
  pinnedMessageIds?: string[]
  /** Set of agentIds currently streaming */
  streamingAgentIds?: Set<string>
  /** All messages in the chatroom, for resolving replyToId */
  messages?: ChatroomMessage[]
  /** Whether this message is grouped with the previous (same sender within 2min) */
  grouped?: boolean
  /** Moment overlay to display above the avatar (heartbeat/tool activity) */
  momentOverlay?: React.ReactNode
}

function formatRelativeTime(ts: number, now: number | null): string {
  if (!now) return 'recently'
  const diffSec = Math.floor((now - ts) / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function getMemberRoleFromChatroom(chatroom: Chatroom | undefined, agentId: string): string {
  if (!chatroom?.members?.length) return 'member'
  const member = chatroom.members.find((m) => m.agentId === agentId)
  return member?.role || 'member'
}

function isAgentMutedInChatroom(chatroom: Chatroom | undefined, agentId: string, now: number | null): boolean {
  if (!chatroom?.members?.length) return false
  const member = chatroom.members.find((m) => m.agentId === agentId)
  if (!member?.mutedUntil) return false
  return !!now && new Date(member.mutedUntil).getTime() > now
}

function roleBadgeStyle(role: string): { label: string; className: string } | null {
  if (role === 'admin') return { label: 'Admin', className: 'bg-purple-500/20 text-purple-400 border-purple-500/30' }
  if (role === 'moderator') return { label: 'Mod', className: 'bg-blue-500/20 text-blue-400 border-blue-500/30' }
  return null
}

/** Pre-process @mentions into markdown-friendly format for ReactMarkdown */
function preprocessMentions(text: string, agents: Record<string, Agent>): string {
  const nameToId = new Map<string, string>()
  for (const [id, agent] of Object.entries(agents)) {
    nameToId.set(agent.name.toLowerCase().replace(/\s+/g, ''), id)
  }
  return text.replace(/@(\S+)/g, (match, name) => {
    const agentId = nameToId.get(name.toLowerCase())
    if (agentId) {
      return `[@${name}](#agent:${agentId})`
    }
    // Unrecognized mentions still get styled as mention links
    return `[@${name}](#mention:${name})`
  })
}

/** Group reactions by emoji */
function groupReactions(reactions: Array<{ emoji: string; reactorId: string }>): Array<{ emoji: string; count: number; hasUser: boolean }> {
  const map = new Map<string, { count: number; hasUser: boolean }>()
  for (const r of reactions) {
    const existing = map.get(r.emoji) || { count: 0, hasUser: false }
    existing.count++
    if (r.reactorId === 'user') existing.hasUser = true
    map.set(r.emoji, existing)
  }
  return Array.from(map.entries()).map(([emoji, data]) => ({ emoji, ...data }))
}

export function ChatroomMessageBubble({ message, agents, onToggleReaction, onReply, onTogglePin, onTransfer, onDeleteMessage, onMuteAgent, onUnmuteAgent, onSetRole, chatroom, pinnedMessageIds, streamingAgentIds, messages, grouped: isGrouped, momentOverlay }: Props) {
  const navigateTo = useNavigate()
  const navigateToAgent = (agentId: string) => navigateTo('agents', agentId)
  const now = useNow({ enabled: false })
  const [showPicker, setShowPicker] = useState(false)
  const [showTransferPicker, setShowTransferPicker] = useState(false)
  const [showModMenu, setShowModMenu] = useState(false)
  const [toolOpen, setToolOpen] = useState(false)
  const userAvatarSeed = useAppStore((s) => s.appSettings.userAvatarSeed)
  const wide = isStructuredMarkdown(message.text)

  // Adapt persisted chatroom tool events to the shared tool-display shape.
  const displayToolEvents = (message.toolEvents ?? []).map((ev, i) => ({
    id: ev.toolCallId || `${message.time}-${ev.name}-${i}`,
    name: ev.name,
    input: ev.input,
    output: ev.output,
    status: (ev.error ? 'error' : 'done') as 'error' | 'done',
    reasoning: ev.reasoning,
  }))
  const hasToolEvents = message.senderId !== 'system' && message.role === 'assistant' && displayToolEvents.length > 0

  // System event messages (join/leave)
  if (message.senderId === 'system') {
    return (
      <div className="flex justify-center py-1.5 px-4">
        <span className="text-[11px] text-text-3/50 font-500 flex items-center gap-1.5">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/40">
            {message.text.includes('left') ? (
              <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>
            ) : (
              <><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" /></>
            )}
          </svg>
          {message.text}
        </span>
      </div>
    )
  }

  const isUser = message.senderId === 'user'
  const agent = !isUser ? agents[message.senderId] : null
  const groupedReactions = groupReactions(message.reactions)

  // Resolve reply-to message
  const replyToMessage = message.replyToId && messages
    ? messages.find((m) => m.id === message.replyToId)
    : null

  // Pre-process text for markdown rendering
  const processedText = preprocessMentions(message.text, agents)

  return (
    <div
      id={`chatroom-msg-${message.id}`}
      className={`group flex gap-2.5 px-4 hover:bg-white/[0.02] ${isGrouped ? 'py-0.5' : 'py-1.5'}`}
      style={{ animation: 'msg-in 0.25s ease-out both' }}
    >
      {/* Avatar or spacer */}
      <div className="shrink-0 mt-0.5 w-7 relative">
        {!isGrouped && (
          isUser ? (
            userAvatarSeed ? (
              <div style={momentOverlay ? { animation: 'avatar-moment-pulse 0.6s ease' } : undefined}>
                <AgentAvatar seed={userAvatarSeed} name={message.senderName} size={28} />
              </div>
            ) : (
              <div className="w-7 h-7 rounded-full bg-white/[0.08] flex items-center justify-center text-[11px] font-600 text-text-2">
                You
              </div>
            )
          ) : agent ? (
            <button
              onClick={() => navigateToAgent(message.senderId)}
              className="bg-transparent border-none p-0 cursor-pointer transition-all duration-150 hover:scale-110 hover:-translate-y-0.5"
              style={momentOverlay ? { animation: 'avatar-moment-pulse 0.6s ease' } : undefined}
            >
              <AgentAvatar seed={agent.avatarSeed || null} avatarUrl={agent.avatarUrl} name={message.senderName} size={28} status={streamingAgentIds?.has(message.senderId) ? 'busy' : 'online'} />
            </button>
          ) : (
            <div style={momentOverlay ? { animation: 'avatar-moment-pulse 0.6s ease' } : undefined}>
              <AgentAvatar seed={null} name={message.senderName} size={28} />
            </div>
          )
        )}
        {momentOverlay}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {!isGrouped && (() => {
          const role = !isUser ? getMemberRoleFromChatroom(chatroom, message.senderId) : 'member'
          const badge = !isUser ? roleBadgeStyle(role) : null
          const muted = !isUser ? isAgentMutedInChatroom(chatroom, message.senderId, now) : false
          return (
            <div className="flex items-baseline gap-2 mb-0.5">
              {!isUser && agent ? (
                <AgentHoverCard agent={agent}>
                  <span className="text-[13px] font-600 text-accent-bright hover:underline cursor-pointer flex items-center gap-1.5">
                    {message.source && <ConnectorPlatformIcon platform={message.source.platform} size={12} />}
                    {message.senderName}
                  </span>
                </AgentHoverCard>
              ) : (
                <span className="text-[13px] font-600 text-text flex items-center gap-1.5">
                  {message.source && <ConnectorPlatformIcon platform={message.source.platform} size={12} />}
                  {isUser && message.source?.senderName
                    ? `${message.source.senderName} via ${getConnectorPlatformLabel(message.source.platform)}`
                    : message.senderName}
                </span>
              )}
              {badge && (
                <span className={`text-[9px] font-600 px-1 py-0.5 rounded border leading-none ${badge.className}`}>
                  {badge.label}
                </span>
              )}
              {muted && (
                <span className="text-[9px] font-600 px-1 py-0.5 rounded border leading-none bg-red-500/20 text-red-400 border-red-500/30">
                  Muted
                </span>
              )}
              {hasToolEvents && (
                <ToolActivityPill
                  toolEvents={displayToolEvents}
                  isOpen={toolOpen}
                  onToggle={() => setToolOpen((v) => !v)}
                />
              )}
              <span className="label-mono" title={new Date(message.time).toISOString()}>{formatRelativeTime(message.time, now)}</span>
            </div>
          )
        })()}

        {/* Tool activity (calls + reasoning) — shown above the answer text */}
        {hasToolEvents && toolOpen && (
          <div className="mb-1.5 rounded-[16px] border border-white/[0.08] bg-surface/72 backdrop-blur-sm overflow-hidden">
            <ToolEventsSection toolEvents={displayToolEvents} controlled />
          </div>
        )}

        {/* Reply quote */}
        {replyToMessage && (
          <ReplyQuote
            senderName={replyToMessage.senderName}
            text={replyToMessage.text}
            onClick={() => {
              const el = document.getElementById(`chatroom-msg-${replyToMessage.id}`)
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                el.classList.add('bg-accent-soft/20')
                setTimeout(() => el.classList.remove('bg-accent-soft/20'), 2000)
              }
            }}
          />
        )}

        {/* Message text with markdown */}
        <div className={`text-[13px] text-text leading-[1.5] break-words chatroom-prose ${wide ? 'max-w-[92%]' : 'max-w-[85%]'}`}>
          <MarkdownBody
            text={processedText}
            renderLink={(href, children) => {
              // Agent mention links (recognized agents — hover card)
              if (href.startsWith('#agent:')) {
                const agentId = href.replace('#agent:', '')
                const mentionAgent = agents[agentId]
                if (mentionAgent) {
                  return (
                    <AgentHoverCard agent={mentionAgent}>
                      <span className="text-accent-bright font-600 bg-accent-soft/40 px-0.5 rounded hover:underline cursor-pointer">
                        {children}
                      </span>
                    </AgentHoverCard>
                  )
                }
                return (
                  <span className="text-accent-bright font-600 bg-accent-soft/40 px-0.5 rounded">
                    {children}
                  </span>
                )
              }
              // Unrecognized @mention — styled but not clickable
              if (href.startsWith('#mention:')) {
                return (
                  <span className="text-accent-bright font-600 bg-accent-soft/40 px-0.5 rounded">
                    {children}
                  </span>
                )
              }
              return null // fall through to default handling
            }}
            renderInlineCode={(_text, children) => (
              <code className="px-1 py-0.5 rounded bg-white/[0.08] text-[12px] font-mono text-accent-bright/90">
                {children}
              </code>
            )}
          />
        </div>

        {/* Attachments */}
        <MessageAttachments
          imagePath={message.imagePath}
          attachedFiles={message.attachedFiles}
          isUser={isUser}
        />

        {/* Tool request banner for agent messages */}
        {!isUser && agent && (
          <ChatroomToolRequestBanner
            agentId={message.senderId}
            agentName={message.senderName}
            text={message.text}
          />
        )}

        {/* Reactions */}
        {groupedReactions.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {groupedReactions.map(({ emoji, count, hasUser }) => (
              <button
                key={emoji}
                onClick={() => onToggleReaction(message.id, emoji)}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] transition-all cursor-pointer ${
                  hasUser
                    ? 'bg-[#1a1a3a] border border-accent-bright/30'
                    : 'bg-[#16162a] border border-white/[0.1] hover:bg-[#1e1e38]'
                }`}
              >
                <span>{emoji}</span>
                {count > 1 && <span className="text-text-3">{count}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Action buttons (reply + pin + transfer + moderate + reaction) */}
      <MessageActions
        layout="inline"
        forceVisible={showPicker || showTransferPicker || showModMenu}
        style={{ zIndex: showPicker || showTransferPicker || showModMenu ? 50 : undefined }}
      >
        {onReply && (
          <ActionButton
            variant="outlined"
            onClick={() => onReply(message)}
            title="Reply"
            icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-3"><polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg>}
          />
        )}
        {onTogglePin && (
          <ActionButton
            variant="outlined"
            onClick={() => onTogglePin(message.id)}
            title={pinnedMessageIds?.includes(message.id) ? 'Unpin message' : 'Pin message'}
            icon={<svg width="12" height="12" viewBox="0 0 24 24" fill={pinnedMessageIds?.includes(message.id) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={pinnedMessageIds?.includes(message.id) ? 'text-amber-400' : 'text-text-3'}><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 2-2H6a2 2 0 0 0 2 2 1 1 0 0 1 1 1z" /></svg>}
          />
        )}
        {onTransfer && !isUser && (
          <ActionButton
            variant="outlined"
            onClick={() => setShowTransferPicker(!showTransferPicker)}
            title="Transfer to agent"
            icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-3"><path d="M8 3L4 7l4 4" /><path d="M4 7h16" /><path d="M16 21l4-4-4-4" /><path d="M20 17H4" /></svg>}
          />
        )}
        {showTransferPicker && onTransfer && (
          <TransferAgentPicker
            excludeIds={[message.senderId]}
            onSelect={(targetId) => {
              onTransfer(message.id, targetId)
              setShowTransferPicker(false)
            }}
            onClose={() => setShowTransferPicker(false)}
          />
        )}
        {!isUser && (onDeleteMessage || onMuteAgent || onSetRole) && (
          <ActionButton
            variant="outlined"
            onClick={() => setShowModMenu(!showModMenu)}
            title="Moderate"
            icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>}
          />
        )}
        {showModMenu && !isUser && (
          <div className="absolute right-0 top-7 z-50 bg-[#1a1a2e] border border-white/[0.1] rounded-[8px] shadow-lg py-1 min-w-[160px]">
            {onDeleteMessage && (
              <button
                onClick={() => {
                  onDeleteMessage(message.id, message.senderId)
                  setShowModMenu(false)
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-red-400 hover:bg-white/[0.06] transition-colors cursor-pointer bg-transparent border-none text-left"
                style={{ fontFamily: 'inherit' }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Delete message
              </button>
            )}
            {onMuteAgent && onUnmuteAgent && (() => {
              const muted = isAgentMutedInChatroom(chatroom, message.senderId, now)
              return muted ? (
                <button
                  onClick={() => {
                    onUnmuteAgent(message.senderId)
                    setShowModMenu(false)
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-green-400 hover:bg-white/[0.06] transition-colors cursor-pointer bg-transparent border-none text-left"
                  style={{ fontFamily: 'inherit' }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                  Unmute agent
                </button>
              ) : (
                <button
                  onClick={() => {
                    onMuteAgent(message.senderId)
                    setShowModMenu(false)
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-amber-400 hover:bg-white/[0.06] transition-colors cursor-pointer bg-transparent border-none text-left"
                  style={{ fontFamily: 'inherit' }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="23" y1="9" x2="17" y2="15" />
                    <line x1="17" y1="9" x2="23" y2="15" />
                  </svg>
                  Mute 30 min
                </button>
              )
            })()}
            {onSetRole && (() => {
              const currentRole = getMemberRoleFromChatroom(chatroom, message.senderId)
              const roleOptions: Array<{ value: 'admin' | 'moderator' | 'member'; label: string }> = [
                { value: 'admin', label: 'Set Admin' },
                { value: 'moderator', label: 'Set Moderator' },
                { value: 'member', label: 'Set Member' },
              ]
              return roleOptions
                .filter((opt) => opt.value !== currentRole)
                .map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => {
                      onSetRole(message.senderId, opt.value)
                      setShowModMenu(false)
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-text-2 hover:bg-white/[0.06] transition-colors cursor-pointer bg-transparent border-none text-left"
                    style={{ fontFamily: 'inherit' }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                      <circle cx="8.5" cy="7" r="4" />
                      <polyline points="17 11 19 13 23 9" />
                    </svg>
                    {opt.label}
                  </button>
                ))
            })()}
            <button
              onClick={() => setShowModMenu(false)}
              className="w-full px-3 py-1.5 text-[11px] text-text-3 hover:bg-white/[0.06] transition-colors cursor-pointer bg-transparent border-none text-left border-t border-white/[0.06] mt-1"
              style={{ fontFamily: 'inherit' }}
            >
              Cancel
            </button>
          </div>
        )}
        <ActionButton
          variant="outlined"
          onClick={() => setShowPicker(!showPicker)}
          title="Add reaction"
          icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-3"><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>}
        />
        {showPicker && (
          <ReactionPicker
            onSelect={(emoji) => {
              onToggleReaction(message.id, emoji)
              setShowPicker(false)
            }}
            onClose={() => setShowPicker(false)}
          />
        )}
      </MessageActions>
    </div>
  )
}
