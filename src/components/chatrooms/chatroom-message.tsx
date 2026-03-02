'use client'

import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { CodeBlock } from '@/components/chat/code-block'
import { ReactionPicker } from './reaction-picker'
import { ReplyQuote } from '@/components/shared/reply-quote'
import { AttachmentChip, parseAttachmentUrl } from '@/components/shared/attachment-chip'
import { useAppStore } from '@/stores/use-app-store'
import { AgentHoverCard } from './agent-hover-card'
import { ChatroomToolRequestBanner } from './chatroom-tool-request-banner'
import { isStructuredMarkdown } from '@/components/chat/markdown-utils'
import { TransferAgentPicker } from '@/components/chat/transfer-agent-picker'
import { ConnectorPlatformIcon, CONNECTOR_PLATFORM_META } from '@/components/shared/connector-platform-icon'
import type { ChatroomMessage, Agent } from '@/types'

interface Props {
  message: ChatroomMessage
  agents: Record<string, Agent>
  onToggleReaction: (messageId: string, emoji: string) => void
  onReply?: (message: ChatroomMessage) => void
  onTogglePin?: (messageId: string) => void
  onTransfer?: (messageId: string, targetAgentId: string) => void
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

function formatRelativeTime(ts: number): string {
  const now = Date.now()
  const diffSec = Math.floor((now - ts) / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function navigateToAgent(agentId: string) {
  useAppStore.getState().setActiveView('agents')
  useAppStore.getState().setCurrentAgent(agentId)
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

// TransferAgentPicker imported from @/components/chat/transfer-agent-picker

/** Render chatroom message attachments */
function renderChatroomAttachments(message: ChatroomMessage) {
  const isUser = message.senderId === 'user'
  const seen = new Set<string>()
  const chips: { url: string; filename: string }[] = []

  if (message.imagePath) {
    const primary = parseAttachmentUrl(message.imagePath)
    if (primary.url) {
      seen.add(primary.url)
      chips.push(primary)
    }
  }
  if (message.attachedFiles?.length) {
    for (const fp of message.attachedFiles) {
      const att = parseAttachmentUrl(fp)
      if (att.url && !seen.has(att.url)) {
        seen.add(att.url)
        chips.push(att)
      }
    }
  }
  if (!chips.length) return null
  return (
    <div className="flex flex-col">
      {chips.map((c) => <AttachmentChip key={c.url} url={c.url} filename={c.filename} isUserMsg={isUser} />)}
    </div>
  )
}

export function ChatroomMessageBubble({ message, agents, onToggleReaction, onReply, onTogglePin, onTransfer, pinnedMessageIds, streamingAgentIds, messages, grouped: isGrouped, momentOverlay }: Props) {
  const [showPicker, setShowPicker] = useState(false)
  const [showTransferPicker, setShowTransferPicker] = useState(false)
  const userAvatarSeed = useAppStore((s) => s.appSettings.userAvatarSeed)
  const wide = isStructuredMarkdown(message.text)

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
              <AgentAvatar seed={agent.avatarSeed || null} name={message.senderName} size={28} status={streamingAgentIds?.has(message.senderId) ? 'busy' : 'online'} />
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
        {!isGrouped && (
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
                  ? `${message.source.senderName} via ${CONNECTOR_PLATFORM_META[message.source.platform]?.label || message.source.platform}`
                  : message.senderName}
              </span>
            )}
            <span className="label-mono" title={new Date(message.time).toLocaleString()}>{formatRelativeTime(message.time)}</span>
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

        {/* Attachments */}
        {renderChatroomAttachments(message)}

        {/* Message text with markdown */}
        <div className={`text-[13px] text-text leading-[1.5] break-words chatroom-prose ${wide ? 'max-w-[92%]' : 'max-w-[85%]'}`}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={{
              pre({ children }) {
                return <pre>{children}</pre>
              },
              code({ className, children }) {
                const isBlock = className?.startsWith('language-') || className?.startsWith('hljs')
                if (isBlock) {
                  return <CodeBlock className={className}>{children}</CodeBlock>
                }
                return (
                  <code className="px-1 py-0.5 rounded bg-white/[0.08] text-[12px] font-mono text-accent-bright/90">
                    {children}
                  </code>
                )
              },
              a({ href, children }) {
                if (!href) return <>{children}</>
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
                // YouTube embeds
                const ytMatch = href.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/)
                if (ytMatch) {
                  return (
                    <div className="my-2">
                      <iframe
                        src={`https://www.youtube.com/embed/${ytMatch[1]}`}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                        className="w-full max-w-[480px] aspect-video rounded-[8px] border border-white/[0.06]"
                      />
                    </div>
                  )
                }
                // Upload links
                if (typeof href === 'string' && href.includes('/api/uploads/')) {
                  const filename = href.split('/').pop() || 'file'
                  return (
                    <a href={href} download={filename} className="text-accent-bright hover:underline">
                      {children}
                    </a>
                  )
                }
                // Default external link
                return (
                  <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-bright hover:underline">
                    {children}
                  </a>
                )
              },
              img({ src, alt }) {
                if (!src || typeof src !== 'string') return null
                const isVideo = /\.(mp4|webm|mov|avi)$/i.test(src)
                if (isVideo) {
                  return <video src={src} controls preload="none" className="max-w-full rounded-[8px] my-2" />
                }
                return (
                  <a href={src} download target="_blank" rel="noopener noreferrer" className="block my-2">
                    <img src={src} alt={alt || 'Image'} loading="lazy" className="max-w-full max-h-[400px] rounded-[8px] border border-white/[0.06]" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                  </a>
                )
              },
            }}
          >
            {processedText}
          </ReactMarkdown>
        </div>

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

      {/* Action buttons (reply + pin + transfer + reaction) */}
      <div className="relative shrink-0 mt-0.5 flex items-start gap-0.5" style={{ zIndex: showPicker || showTransferPicker ? 50 : undefined }}>
        {/* Reply button */}
        {onReply && (
          <button
            onClick={() => onReply(message)}
            className="opacity-0 group-hover:opacity-100 w-6 h-6 rounded-full flex items-center justify-center hover:bg-white/[0.08] transition-all cursor-pointer"
            title="Reply"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-3">
              <polyline points="9 17 4 12 9 7" />
              <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
            </svg>
          </button>
        )}
        {/* Pin button */}
        {onTogglePin && (
          <button
            onClick={() => onTogglePin(message.id)}
            className="opacity-0 group-hover:opacity-100 w-6 h-6 rounded-full flex items-center justify-center hover:bg-white/[0.08] transition-all cursor-pointer"
            title={pinnedMessageIds?.includes(message.id) ? 'Unpin message' : 'Pin message'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill={pinnedMessageIds?.includes(message.id) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={pinnedMessageIds?.includes(message.id) ? 'text-amber-400' : 'text-text-3'}>
              <path d="M12 17v5" />
              <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 2-2H6a2 2 0 0 0 2 2 1 1 0 0 1 1 1z" />
            </svg>
          </button>
        )}
        {/* Transfer button */}
        {onTransfer && !isUser && (
          <button
            onClick={() => setShowTransferPicker(!showTransferPicker)}
            className="opacity-0 group-hover:opacity-100 w-6 h-6 rounded-full flex items-center justify-center hover:bg-white/[0.08] transition-all cursor-pointer"
            title="Transfer to agent"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-3">
              <path d="M8 3L4 7l4 4" />
              <path d="M4 7h16" />
              <path d="M16 21l4-4-4-4" />
              <path d="M20 17H4" />
            </svg>
          </button>
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
        {/* Reaction button */}
        <button
          onClick={() => setShowPicker(!showPicker)}
          className="opacity-0 group-hover:opacity-100 w-6 h-6 rounded-full flex items-center justify-center hover:bg-white/[0.08] transition-all cursor-pointer"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-3">
            <circle cx="12" cy="12" r="10" />
            <path d="M8 14s1.5 2 4 2 4-2 4-2" />
            <line x1="9" y1="9" x2="9.01" y2="9" />
            <line x1="15" y1="9" x2="15.01" y2="9" />
          </svg>
        </button>
        {showPicker && (
          <ReactionPicker
            onSelect={(emoji) => {
              onToggleReaction(message.id, emoji)
              setShowPicker(false)
            }}
            onClose={() => setShowPicker(false)}
          />
        )}
      </div>
    </div>
  )
}
