'use client'

import { memo, useState, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Message } from '@/types'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { AiAvatar } from '@/components/shared/avatar'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { CodeBlock } from './code-block'
import { ToolCallBubble, extractMedia } from './tool-call-bubble'
import { ToolRequestBanner } from './tool-request-banner'
import { AttachmentChip, parseAttachmentUrl } from '@/components/shared/attachment-chip'
import { isStructuredMarkdown } from './markdown-utils'
import { FilePathChip, FILE_PATH_RE, DIR_PATH_RE } from './file-path-chip'
import { TransferAgentPicker } from './transfer-agent-picker'
import { DelegationBanner, DelegationSourceBanner, TaskCompletionCard, parseTaskCompletion } from './delegation-banner'
import { SwarmPanel, parseSwarmOutput, parseSwarmStatusOutput } from './swarm-panel'
import { SwarmStatusCard, SwarmStatusStyles } from './swarm-status-card'
import { ConnectorPlatformIcon, getConnectorPlatformLabel } from '@/components/shared/connector-platform-icon'
import { copyTextToClipboard } from '@/lib/clipboard'
import { formatMessageTimestamp } from '@/lib/chat-display'

/** Parse delegation-source metadata prefix from system messages */
const DELEGATION_SOURCE_RE = /^\[delegation-source:([^:]*):([^:]*):([^\]]*)\]/
function parseDelegationSource(text: string): { delegatorId: string; delegatorName: string; delegatorAvatarSeed: string; rest: string } | null {
  const m = text.match(DELEGATION_SOURCE_RE)
  if (!m) return null
  return { delegatorId: m[1], delegatorName: m[2], delegatorAvatarSeed: m[3], rest: text.slice(m[0].length).replace(/^\n/, '') }
}

/** Try to parse JSON safely, returning null on failure */
function tryParseJson(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s) } catch { return null }
}

function connectorThreadMeta(message: Message, isUser: boolean): string | null {
  const source = message.source
  if (!source) return null
  const connectorName = source.connectorName?.trim() || getConnectorPlatformLabel(source.platform)
  if (isUser) {
    const sender = source.senderName?.trim() || source.senderId?.trim() || source.channelId?.trim()
    return sender ? `${connectorName} · ${sender}` : connectorName
  }
  const recipient = source.senderName?.trim() || source.senderId?.trim() || source.channelId?.trim()
  return recipient ? `${connectorName} · to ${recipient}` : connectorName
}

interface HeartbeatMeta {
  goal?: string
  status?: string
  next_action?: string
}

function parseHeartbeatMeta(text: string): HeartbeatMeta | null {
  const match = text.match(/\[AGENT_HEARTBEAT_META\]\s*(\{[^\n]*\})/i)
  if (!match?.[1]) return null
  try {
    const parsed = JSON.parse(match[1])
    if (typeof parsed === 'object' && parsed !== null) return parsed as HeartbeatMeta
  } catch { /* ignore */ }
  return null
}

function heartbeatSummary(text: string): string {
  const clean = (text || '')
    .replace(/\bHEARTBEAT_OK\b/gi, '')
    .replace(/\[AGENT_HEARTBEAT_META\]\s*\{[^\n]*\}/gi, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\([^)]+\)/g, '$1')
    .replace(/\bHeartbeat Response\s*:\s*/gi, '')
    .replace(/\bCurrent (State|Status)\s*:\s*/gi, '')
    .replace(/\bRecent Progress\s*:\s*/gi, '')
    .replace(/\bNext (Step|Immediate Step)\s*:\s*/gi, '')
    .replace(/\bStatus\s*:\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return 'No new status update.'
  return clean.length > 180 ? `${clean.slice(0, 180)}...` : clean
}

const STATUS_COLORS: Record<string, string> = {
  progress: '#F59E0B',
  ok: '#22C55E',
  idle: '#6B7280',
  blocked: '#EF4444',
}

const emptyToolEvents: NonNullable<Message['toolEvents']> = []

// AttachmentChip, parseAttachmentUrl, regex constants, and FILE_TYPE_COLORS
// are now imported from @/components/shared/attachment-chip

function renderAttachments(message: Message) {
  const isUser = message.role === 'user'
  const seen = new Set<string>()
  const chips: { url: string; filename: string }[] = []

  // Primary attachment
  if (message.imagePath || message.imageUrl) {
    const primary = parseAttachmentUrl(message.imagePath, message.imageUrl)
    if (primary.url) {
      seen.add(primary.url)
      chips.push(primary)
    }
  }

  // Additional attached files
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

interface Props {
  message: Message
  assistantName?: string
  agentAvatarSeed?: string
  agentAvatarUrl?: string | null
  agentName?: string
  isLast?: boolean
  onRetry?: () => void
  messageIndex?: number
  onToggleBookmark?: (index: number) => void
  onEditResend?: (index: number, newText: string) => void
  onFork?: (index: number) => void
  onTransferToAgent?: (messageIndex: number, agentId: string) => void
  momentOverlay?: React.ReactNode
}

export const MessageBubble = memo(function MessageBubble({ message, assistantName, agentAvatarSeed, agentAvatarUrl, agentName, isLast, onRetry, messageIndex, onToggleBookmark, onEditResend, onFork, onTransferToAgent, momentOverlay }: Props) {
  const isUser = message.role === 'user'
  const isHeartbeat = !isUser && (message.kind === 'heartbeat' || /^\s*HEARTBEAT_OK\b/i.test(message.text || ''))
  const isPluginUI = !isUser && message.kind === 'plugin-ui'
  const scaffoldRequest = useMemo(() => {
    if (isUser) return null
    try {
      const data = JSON.parse(message.text)
      if (data.type === 'plugin_scaffold_request') return data
    } catch { /* ignore */ }
    return null
  }, [message.text, isUser])

  const installRequest = useMemo(() => {
    if (isUser) return null
    try {
      const data = JSON.parse(message.text)
      if (data.type === 'plugin_install_request') return data
    } catch { /* ignore */ }
    return null
  }, [message.text, isUser])

  const walletRequest = useMemo(() => {
    if (isUser) return null
    try {
      const data = JSON.parse(message.text)
      if (data.type === 'plugin_wallet_transfer_request') return data
    } catch { /* ignore */ }
    return null
  }, [message.text, isUser])

  const walletActionRequest = useMemo(() => {
    if (isUser) return null
    try {
      const data = JSON.parse(message.text)
      if (data.type === 'plugin_wallet_action_request') return data
    } catch { /* ignore */ }
    return null
  }, [message.text, isUser])
  const currentUser = useAppStore((s) => s.currentUser)
  const [copied, setCopied] = useState(false)
  const [heartbeatExpanded, setHeartbeatExpanded] = useState(false)
  const [toolEventsExpanded, setToolEventsExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const [transferPickerOpen, setTransferPickerOpen] = useState(false)
  const toolEvents = message.toolEvents ?? emptyToolEvents
  // Separate send_file events — they render as inline attachments, not in the tool accordion
  const nonSendFileEvents = useMemo(() => toolEvents.filter((ev) => ev.name !== 'send_file' || ev.error), [toolEvents])
  const hasToolEvents = !isUser && nonSendFileEvents.length > 0
  const visibleToolEvents = toolEventsExpanded ? [...nonSendFileEvents].reverse() : nonSendFileEvents.slice(-1)

  // Extract ALL media from ALL tool events for inline display after the message text.
  // Covers send_file, browser screenshots, file tool outputs — everything.
  const allToolMedia = useMemo(() => {
    const images: { name: string; url: string }[] = []
    const videos: { name: string; url: string }[] = []
    const pdfs: { name: string; url: string }[] = []
    const files: { name: string; url: string }[] = []
    const seen = new Set<string>()

    for (const ev of toolEvents) {
      if (ev.error || !ev.output) continue
      const m = extractMedia(ev.output)
      for (const url of m.images) {
        if (!seen.has(url)) { seen.add(url); images.push({ name: url.split('/').pop() || 'Image', url }) }
      }
      for (const url of m.videos) {
        if (!seen.has(url)) { seen.add(url); videos.push({ name: url.split('/').pop() || 'Video', url }) }
      }
      for (const p of m.pdfs) {
        if (!seen.has(p.url)) { seen.add(p.url); pdfs.push(p) }
      }
      for (const f of m.files) {
        // Reclassify image-extension files as images (send_file uses [label](url) not ![](url))
        if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(f.url)) {
          if (!seen.has(f.url)) { seen.add(f.url); images.push(f) }
        } else {
          if (!seen.has(f.url)) { seen.add(f.url); files.push(f) }
        }
      }
    }

    if (!images.length && !videos.length && !pdfs.length && !files.length) return null
    return { images, videos, pdfs, files }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.toolEvents])
  const isStructured = !isUser && !isHeartbeat && isStructuredMarkdown(message.text)

  // Collect all media URLs already rendered via tool events to avoid duplicates in markdown
  const toolEventMediaUrls = useMemo(() => {
    if (!toolEvents.length) return null
    const urls = new Set<string>()
    for (const ev of toolEvents) {
      if (!ev.output) continue
      const m = extractMedia(ev.output)
      for (const url of m.images) urls.add(url)
      for (const url of m.videos) urls.add(url)
    }
    return urls.size > 0 ? urls : null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.toolEvents])

  // Detect delegation-source system messages
  const delegationSource = !isUser && message.kind === 'system' ? parseDelegationSource(message.text || '') : null
  // Detect task completion system messages (delegated or direct)
  const taskCompletion = !isUser && message.kind === 'system' ? parseTaskCompletion(message.text || '') : null
  const rawDisplayText = delegationSource ? delegationSource.rest : message.text
  const displayText = rawDisplayText
    ? rawDisplayText.split('\n').filter((l) => !/\[(MAIN_LOOP_META|MAIN_LOOP_PLAN|MAIN_LOOP_REVIEW|AGENT_HEARTBEAT_META)\]/.test(l)).join('\n').trim()
    : ''

  const handleCopy = useCallback(() => {
    void copyTextToClipboard(message.text).then((copiedText) => {
      if (!copiedText) return
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [message.text])

  const connectorMeta = connectorThreadMeta(message, isUser)

  return (
    <div
      className={`group ${isUser ? 'flex flex-col items-end' : 'flex flex-col items-start relative pl-[44px]'}`}
    >
      {/* Avatar on spine (assistant) */}
      {!isUser && (
        <div className="absolute left-[4px] top-0">
          <div style={momentOverlay ? { animation: 'avatar-moment-pulse 0.6s ease' } : undefined}>
            {agentName ? <AgentAvatar seed={agentAvatarSeed || null} avatarUrl={agentAvatarUrl} name={agentName} size={28} /> : <AiAvatar size="sm" />}
          </div>
          {momentOverlay}
        </div>
      )}
      {/* Sender label + timestamp */}
      <div className={`flex flex-col gap-0.5 mb-2 px-1 ${isUser ? 'items-end' : 'items-start'}`}>
        <div className={`flex items-center gap-2.5 ${isUser ? 'flex-row-reverse' : ''}`}>
          <span className={`text-[12px] font-600 flex items-center gap-1.5 ${isUser ? 'text-accent-bright/70' : 'text-text-3'}`}>
            {message.source && (
              <ConnectorPlatformIcon platform={message.source.platform} size={12} />
            )}
            {isUser
              ? (message.source?.senderName
                  ? `${message.source.senderName} via ${getConnectorPlatformLabel(message.source.platform)}`
                  : (currentUser ? currentUser.charAt(0).toUpperCase() + currentUser.slice(1) : 'You'))
              : (message.source
                  ? `${assistantName || 'Claude'} via ${getConnectorPlatformLabel(message.source.platform)}`
                  : (assistantName || 'Claude'))}
          </span>
          <span className="text-[11px] text-text-3/70 font-mono" title={message.time ? new Date(message.time).toLocaleString() : ''}>
            {message.time ? formatMessageTimestamp(message) : ''}
          </span>
        </div>
        {connectorMeta && (
          <div className={`text-[10px] font-mono text-text-3/55 ${isUser ? 'text-right' : ''}`}>
            {connectorMeta}
          </div>
        )}
      </div>

      {/* Tool call events (assistant messages only) */}
      {hasToolEvents && (
        <div className="max-w-[85%] md:max-w-[72%] flex flex-col gap-2 mb-2">
          {nonSendFileEvents.length > 1 && (
            <button
              type="button"
              onClick={() => setToolEventsExpanded((v) => !v)}
              className="self-start px-2.5 py-1 rounded-[8px] bg-white/[0.04] hover:bg-white/[0.07] text-[11px] text-text-3 border border-white/[0.06] cursor-pointer transition-colors"
            >
              {toolEventsExpanded ? 'Show latest only' : `Show all tool calls (${nonSendFileEvents.length})`}
            </button>
          )}
          <div className={`${toolEventsExpanded ? 'max-h-[320px] overflow-y-auto pr-1 flex flex-col gap-2' : 'flex flex-col gap-2'}`}>
            {visibleToolEvents.map((event, i) => {
              const eventKey = event.toolCallId || `${message.time}-${event.name}-${event.input}`
              const key = `${message.time}-tool-${toolEventsExpanded ? `all-${eventKey}` : `latest-${eventKey}`}`

              if (event.name === 'spawn_subagent' && event.output) {
                // Prefer rich SwarmStatusCard when snapshot data is available
                const statusData = parseSwarmStatusOutput(event.name, event.output)
                if (statusData) {
                  return <div key={key}><SwarmStatusStyles /><SwarmStatusCard data={statusData} /></div>
                }
                const swarmData = parseSwarmOutput(event.name, event.output)
                if (swarmData) {
                  return <SwarmPanel key={key} data={swarmData} />
                }
              }

              if (event.name === 'delegate_to_agent') {
                const inp = tryParseJson(event.input || '{}')
                const out = tryParseJson(event.output || '{}')
                return (
                  <DelegationBanner
                    key={key}
                    agentName={out?.agentName as string || inp?.agentName as string || inp?.agentId as string || 'Agent'}
                    agentAvatarSeed={(out?.agentAvatarSeed as string) || null}
                    taskPreview={(inp?.task as string || '').slice(0, 100)}
                    taskId={(out?.taskId as string) || null}
                    status="delegating"
                  />
                )
              }

              if (event.name === 'check_delegation_status') {
                const out = tryParseJson(event.output || '{}')
                const rawStatus = out?.status as string || ''
                const mapped = rawStatus === 'completed' ? 'completed' as const
                  : rawStatus === 'failed' ? 'failed' as const
                  : 'checking' as const
                return (
                  <DelegationBanner
                    key={key}
                    agentName={out?.agentName as string || 'Agent'}
                    agentAvatarSeed={(out?.agentAvatarSeed as string) || null}
                    taskPreview={(out?.title as string || '').slice(0, 100)}
                    taskId={(out?.taskId as string) || null}
                    status={mapped}
                  />
                )
              }

              return (
                <ToolCallBubble
                  key={key}
                  event={{
                    id: event.toolCallId || `${message.time}-${toolEventsExpanded ? i : toolEvents.length - 1}`,
                    name: event.name,
                    input: event.input,
                    output: event.output,
                    status: event.error ? 'error' : 'done',
                    
                  }}
                />
              )
            })}
          </div>
        </div>
      )}

      {/* Thinking block (collapsible, shown for assistant messages with persisted thinking) */}
      {!isUser && message.thinking && (
        <div className="max-w-[85%] md:max-w-[72%] mb-2">
          <details className="group rounded-[12px] border border-purple-500/15 bg-purple-500/[0.04]">
            <summary className="flex items-center gap-2 px-3.5 py-2.5 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-purple-400/60 shrink-0 transition-transform group-open:rotate-90">
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span className="text-[11px] font-600 text-purple-400/70 uppercase tracking-[0.05em]">Thinking</span>
              <span className="text-[10px] text-text-3/40 font-mono">{Math.ceil(message.thinking.length / 4)} tokens</span>
            </summary>
            <div className="px-3.5 pb-3 pt-1 max-h-[300px] overflow-y-auto">
              <div className="text-[13px] leading-[1.6] text-text-3/70 whitespace-pre-wrap break-words">
                {message.thinking}
              </div>
            </div>
          </details>
        </div>
      )}

      {/* Delegation source banner (receiving agent's chat) */}
      {delegationSource && (() => {
        const taskLinkMatch = delegationSource.rest.match(/\[([^\]]+)\]\(#task:([^)]+)\)/)
        const dsTaskTitle = taskLinkMatch?.[1] || ''
        const dsTaskId = taskLinkMatch?.[2] || null
        const descLines = delegationSource.rest.split('\n\n').slice(1).filter((l) => !l.startsWith('Working directory:') && !l.startsWith("I'll begin"))
        const dsDescription = descLines.join(' ').trim().slice(0, 200)
        return (
          <div className="max-w-[85%] md:max-w-[72%] mb-2">
            <DelegationSourceBanner
              delegatorName={delegationSource.delegatorName}
              delegatorAvatarSeed={delegationSource.delegatorAvatarSeed || null}
              taskTitle={dsTaskTitle}
              taskId={dsTaskId}
              description={dsDescription}
            />
          </div>
        )
      })()}

      {/* Task completion card (replaces bubble for task result system messages) */}
      {taskCompletion ? (
        <div className="max-w-[85%] md:max-w-[72%]">
          <TaskCompletionCard info={{ ...taskCompletion, imageUrl: message.imageUrl }} />
        </div>
      ) : (
      /* Message bubble */
      <div className={`${isStructured ? 'max-w-[92%] md:max-w-[85%]' : 'max-w-[85%] md:max-w-[72%]'} ${isUser ? 'bubble-user px-5 py-3.5' : isHeartbeat ? 'bubble-ai px-4 py-3' : 'bubble-ai px-5 py-3.5'}`}>
        {renderAttachments(message)}

        {walletRequest ? (
          <div className="flex flex-col gap-3 p-4 rounded-[18px] bg-sky-500/[0.03] border border-sky-500/20 shadow-[0_0_20px_rgba(14,165,233,0.05)]">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-5 h-5 rounded-full bg-sky-500/20 flex items-center justify-center text-sky-400">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
              </div>
              <span className="text-[11px] font-700 uppercase tracking-wider text-sky-400/80">Wallet Transfer Request</span>
            </div>
            <p className="text-[13px] text-text-2/90 leading-relaxed">{walletRequest.message}</p>
            <div className="p-3 rounded-[12px] bg-black/40 border border-white/5 flex flex-col gap-2">
              <div className="flex justify-between items-center">
                <span className="text-[11px] text-text-3/60 font-600 uppercase">Amount</span>
                <span className="text-[13px] font-700 text-sky-400">{walletRequest.amountDisplay || `${walletRequest.amountSol} SOL`}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-text-3/60 font-600 uppercase">To Address</span>
                <span className="text-[11px] font-mono text-text-2/70 break-all">{walletRequest.toAddress}</span>
              </div>
              {walletRequest.memo && (
                <div className="flex flex-col gap-1 border-t border-white/5 pt-2">
                  <span className="text-[11px] text-text-3/60 font-600 uppercase">Memo</span>
                  <span className="text-[12px] text-text-3/80 italic">&quot;{walletRequest.memo}&quot;</span>
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-1">
              <button
                onClick={() => useChatStore.getState().sendMessage(`I approve this transfer of ${walletRequest.amountDisplay || `${walletRequest.amountSol} SOL`} to ${walletRequest.toAddress}. Proceed with wallet_tool and set approved=true.`)}
                className="px-4 py-2 rounded-[12px] bg-sky-500 text-black text-[13px] font-700 hover:bg-sky-400 transition-all active:scale-[0.98]"
              >
                Approve & Send
              </button>
              <button
                onClick={() => useChatStore.getState().sendMessage(`I do not approve this transaction. Cancel it.`)}
                className="px-4 py-2 rounded-[12px] bg-white/[0.05] hover:bg-white/[0.1] text-text-2 text-[13px] font-600 transition-all border border-white/10"
              >
                Reject
              </button>
            </div>
          </div>
        ) : walletActionRequest ? (
          <div className="flex flex-col gap-3 p-4 rounded-[18px] bg-violet-500/[0.03] border border-violet-500/20 shadow-[0_0_20px_rgba(139,92,246,0.05)]">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-5 h-5 rounded-full bg-violet-500/20 flex items-center justify-center text-violet-400">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 2v8" />
                  <path d="M8 6h8" />
                  <path d="m5 19 4-4 3 3 7-7" />
                </svg>
              </div>
              <span className="text-[11px] font-700 uppercase tracking-wider text-violet-400/80">Wallet Action Request</span>
            </div>
            <p className="text-[13px] text-text-2/90 leading-relaxed">{walletActionRequest.message}</p>
            <div className="p-3 rounded-[12px] bg-black/40 border border-white/5 flex flex-col gap-2">
              <div className="flex justify-between items-center gap-3">
                <span className="text-[11px] text-text-3/60 font-600 uppercase">Action</span>
                <span className="text-[13px] font-700 text-violet-400">{walletActionRequest.action || 'wallet_action'}</span>
              </div>
              {(walletActionRequest.chain || walletActionRequest.network) && (
                <div className="flex justify-between items-center gap-3">
                  <span className="text-[11px] text-text-3/60 font-600 uppercase">Chain</span>
                  <span className="text-[12px] text-text-2/80">{[walletActionRequest.chain, walletActionRequest.network].filter(Boolean).join(' / ')}</span>
                </div>
              )}
              {walletActionRequest.summary && (
                <div className="flex flex-col gap-1 border-t border-white/5 pt-2">
                  <span className="text-[11px] text-text-3/60 font-600 uppercase">Summary</span>
                  <span className="text-[12px] text-text-2/80 whitespace-pre-wrap break-words">{walletActionRequest.summary}</span>
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-1">
              <button
                onClick={() => useChatStore.getState().sendMessage(`I approve this wallet action (${walletActionRequest.action || 'wallet_action'}). Proceed with wallet_tool and set approved=true.`)}
                className="px-4 py-2 rounded-[12px] bg-violet-500 text-black text-[13px] font-700 hover:bg-violet-400 transition-all active:scale-[0.98]"
              >
                Approve Action
              </button>
              <button
                onClick={() => useChatStore.getState().sendMessage('I do not approve this wallet action. Cancel it.')}
                className="px-4 py-2 rounded-[12px] bg-white/[0.05] hover:bg-white/[0.1] text-text-2 text-[13px] font-600 transition-all border border-white/10"
              >
                Reject
              </button>
            </div>
          </div>
        ) : installRequest ? (
          <div className="flex flex-col gap-3 p-4 rounded-[18px] bg-emerald-500/[0.03] border border-emerald-500/20 shadow-[0_0_20px_rgba(16,185,129,0.05)]">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center text-emerald-400">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <span className="text-[11px] font-700 uppercase tracking-wider text-emerald-400/80">Plugin Install Request</span>
            </div>
            <p className="text-[13px] text-text-2/90 leading-relaxed">{installRequest.message}</p>
            <div className="p-3 rounded-[12px] bg-black/40 border border-white/5 flex flex-col gap-1">
              <div className="text-[11px] text-text-3/60 font-600 uppercase tracking-tight">Source URL</div>
              <div className="text-[12px] font-mono text-emerald-200/70 truncate">{installRequest.url}</div>
            </div>
            <div className="flex gap-2 mt-1">
              <button
                onClick={() => useChatStore.getState().sendMessage(`I approve the installation of the plugin from ${installRequest.url}. Proceed with install_request and set approved=true.`)}
                className="px-4 py-2 rounded-[12px] bg-emerald-500 text-black text-[13px] font-700 hover:bg-emerald-400 transition-all active:scale-[0.98]"
              >
                Approve & Install
              </button>
              <button
                onClick={() => useChatStore.getState().sendMessage(`I do not approve this plugin installation. Please stop.`)}
                className="px-4 py-2 rounded-[12px] bg-white/[0.05] hover:bg-white/[0.1] text-text-2 text-[13px] font-600 transition-all border border-white/10"
              >
                Reject
              </button>
            </div>
          </div>
        ) : scaffoldRequest ? (
          <div className="flex flex-col gap-3 p-4 rounded-[18px] bg-amber-500/[0.03] border border-amber-500/20 shadow-[0_0_20px_rgba(245,158,11,0.05)]">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-5 h-5 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-400">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
              </div>
              <span className="text-[11px] font-700 uppercase tracking-wider text-amber-400/80">Plugin Creation Request</span>
            </div>
            <p className="text-[13px] text-text-2/90 leading-relaxed">{scaffoldRequest.message}</p>
            <div className="p-3 rounded-[12px] bg-black/40 border border-white/5">
              <div className="text-[11px] font-mono text-text-3/60 mb-2 border-b border-white/5 pb-1">filename: {scaffoldRequest.filename}</div>
              <div className="text-[12px] font-mono text-amber-200/70 max-h-[200px] overflow-y-auto whitespace-pre-wrap break-all">
                {scaffoldRequest.code}
              </div>
            </div>
            <div className="flex gap-2 mt-1">
              <button
                onClick={() => useChatStore.getState().sendMessage(`I approve the creation of the plugin ${scaffoldRequest.filename}. Proceed with scaffold and set approved=true.`)}
                className="px-4 py-2 rounded-[12px] bg-amber-500 text-black text-[13px] font-700 hover:bg-amber-400 transition-all active:scale-[0.98]"
              >
                Approve & Install
              </button>
              <button
                onClick={() => useChatStore.getState().sendMessage(`I do not approve the creation of this plugin. Please find another way or stop.`)}
                className="px-4 py-2 rounded-[12px] bg-white/[0.05] hover:bg-white/[0.1] text-text-2 text-[13px] font-600 transition-all border border-white/10"
              >
                Reject
              </button>
            </div>
          </div>
        ) : isPluginUI ? (
          <div className="flex flex-col gap-2 p-4 rounded-[18px] bg-emerald-500/[0.03] border border-emerald-500/10 shadow-[0_0_20px_rgba(16,185,129,0.05)]">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
              </div>
              <span className="text-[11px] font-700 uppercase tracking-wider text-emerald-400/80">Plugin UI Extension</span>
            </div>
            <div className="text-[14px] text-text-2/90 leading-relaxed">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
            </div>
            <div className="flex gap-2 mt-2">
              {tryParseJson(message.text)?.actions ? (tryParseJson(message.text)!.actions as Array<{ id: string; href: string; label: string }>).map((action) => (
                <button
                  key={action.id}
                  onClick={() => window.open(action.href, '_blank')}
                  className="px-3 py-1.5 rounded-[10px] bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-[11px] font-600 transition-all border border-emerald-500/10"
                >
                  {action.label}
                </button>
              )) : null}
            </div>
          </div>
        ) : isHeartbeat ? (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setHeartbeatExpanded((v) => !v)}
              className="w-full rounded-[12px] px-3.5 py-3 border border-white/[0.10] bg-white/[0.02] text-left hover:bg-white/[0.04] transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  {(() => {
                    const meta = parseHeartbeatMeta(message.text)
                    const statusColor = meta?.status ? (STATUS_COLORS[meta.status] || '#6B7280') : '#22C55E'
                    return <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: statusColor }} />
                  })()}
                  <span className="text-[11px] uppercase tracking-[0.08em] text-text-2 font-600">Heartbeat</span>
                  {(() => {
                    const meta = parseHeartbeatMeta(message.text)
                    if (!meta?.status) return null
                    const color = STATUS_COLORS[meta.status] || '#6B7280'
                    return <span className="text-[10px] font-500 px-1.5 py-0.5 rounded-[4px]" style={{ color, background: `${color}18` }}>{meta.status}</span>
                  })()}
                </div>
                <span className="text-[11px] text-text-3">{heartbeatExpanded ? 'Collapse' : 'Expand'}</span>
              </div>
              {(() => {
                const meta = parseHeartbeatMeta(message.text)
                if (meta && (meta.goal || meta.next_action)) {
                  return (
                    <div className="mt-2 flex flex-col gap-1">
                      {meta.goal && (
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-[10px] uppercase tracking-[0.06em] text-text-3 font-600 shrink-0">Goal</span>
                          <span className="text-[12px] text-text-2/90 truncate">{meta.goal}</span>
                        </div>
                      )}
                      {meta.next_action && (
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-[10px] uppercase tracking-[0.06em] text-text-3 font-600 shrink-0">Next</span>
                          <span className="text-[12px] text-text-2/90 truncate">{meta.next_action}</span>
                        </div>
                      )}
                    </div>
                  )
                }
                return <p className="text-[13px] text-text-2/90 leading-[1.5] mt-1.5">{heartbeatSummary(message.text)}</p>
              })()}
            </button>
            {heartbeatExpanded && (
              <div className="msg-content text-[14px] leading-[1.7] text-text break-words px-3 py-2 rounded-[10px] border border-white/[0.08] bg-black/20">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  components={{
                    pre({ children }) {
                      return <pre>{children}</pre>
                    },
                    code({ className, children }) {
                      const isBlock = className?.startsWith('language-') || className?.startsWith('hljs')
                      if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>
                      return <code className={className}>{children}</code>
                    },
                  }}
                >
                  {message.text.replace(/\[AGENT_HEARTBEAT_META\]\s*\{[^\n]*\}/gi, '').trim()}
                </ReactMarkdown>
              </div>
            )}
          </div>
        ) : (
          <div className={`msg-content text-[15px] md:text-[14px] break-words ${isUser ? 'leading-[1.6] text-white/95' : 'leading-[1.7] text-text'}`}>
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
                  // Detect file/dir paths in inline code and make them interactive
                  const text = typeof children === 'string' ? children : ''
                  if (text && (FILE_PATH_RE.test(text) || (DIR_PATH_RE.test(text) && text.split('/').length > 2))) {
                    return <FilePathChip filePath={text.replace(/\/$/, '')} />
                  }
                  return <code className={className}>{children}</code>
                },
                img({ src, alt }) {
                  if (!src || typeof src !== 'string') return null
                  // Skip images already rendered via tool events
                  if (toolEventMediaUrls?.has(src)) return null
                  const isVideo = /\.(mp4|webm|mov|avi)$/i.test(src)
                  if (isVideo) {
                    return (
                      <video src={src} controls preload="none" className="max-w-full rounded-[10px] border border-white/10 my-2" />
                    )
                  }
                  return (
                    <a href={src} download target="_blank" rel="noopener noreferrer" className="block my-2">
                      <img src={src} alt={alt || 'File'} loading="lazy" className="max-w-full rounded-[10px] border border-white/10 hover:border-white/25 transition-colors cursor-pointer" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                    </a>
                  )
                },
                a({ href, children }) {
                  if (!href) return <>{children}</>
                  // Internal app links: #task:<id> and #schedule:<id>
                  const taskMatch = href.match(/^#task:(.+)$/)
                  if (taskMatch) {
                    return (
                      <button
                        type="button"
                        onClick={async () => {
                          const store = useAppStore.getState()
                          await store.loadTasks(true)
                          store.setTaskSheetViewOnly(true)
                          store.setEditingTaskId(taskMatch[1])
                          store.setTaskSheetOpen(true)
                        }}
                        className="inline-flex items-center gap-1 text-purple-400 hover:text-purple-300 underline cursor-pointer bg-transparent border-none p-0 font-inherit text-inherit"
                      >
                        {children}
                      </button>
                    )
                  }
                  const schedMatch = href.match(/^#schedule:(.+)$/)
                  if (schedMatch) {
                    return (
                      <button
                        type="button"
                        onClick={async () => {
                          const store = useAppStore.getState()
                          await store.loadSchedules()
                          store.setEditingScheduleId(schedMatch[1])
                          store.setScheduleSheetOpen(true)
                        }}
                        className="inline-flex items-center gap-1 text-amber-400 hover:text-amber-300 underline cursor-pointer bg-transparent border-none p-0 font-inherit text-inherit"
                      >
                        {children}
                      </button>
                    )
                  }
                  const isUpload = href.startsWith('/api/uploads/')
                  if (isUpload) {
                    const uploadIsHtml = /\.(html?|svg)$/i.test(href.split('?')[0])
                    return (
                      <span className="inline-flex items-center gap-1.5">
                        <a href={href} download className="inline-flex items-center gap-1.5 text-sky-400 hover:text-sky-300 underline">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                          </svg>
                          {children}
                        </a>
                        {uploadIsHtml && (
                          <a href={href} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-accent-soft hover:bg-accent-soft/80 text-accent-bright text-[10px] font-600 no-underline transition-colors"
                            title="Preview in new tab">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                            Preview
                          </a>
                        )}
                      </span>
                    )
                  }
                  // YouTube embed
                  const ytMatch = href.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/)
                  if (ytMatch) {
                    return (
                      <div className="my-2">
                        <iframe
                          src={`https://www.youtube-nocookie.com/embed/${ytMatch[1]}`}
                          className="w-full aspect-video rounded-[10px] border border-white/10"
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                          title="YouTube video"
                        />
                      </div>
                    )
                  }
                  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                },
              }}
            >
              {displayText}
            </ReactMarkdown>
          </div>
        )}
      </div>
      )}

      {/* Inline media from all tool outputs — images, videos, PDFs, files */}
      {allToolMedia && (
        <div className="max-w-[85%] md:max-w-[72%] flex flex-col gap-2 mt-1 mb-2">
          {allToolMedia.images.map((img, i) => (
            <div key={`tm-img-${i}`} className="relative group/img">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.url}
                alt={img.name}
                loading="lazy"
                className="max-w-[400px] rounded-[10px] border border-white/10 cursor-pointer hover:border-white/25 transition-all"
                onClick={() => {
                  import('@/stores/use-chat-store').then(({ useChatStore }) =>
                    useChatStore.getState().setPreviewContent({ type: 'image', url: img.url, title: img.name })
                  )
                }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
              <a
                href={img.url}
                download
                onClick={(e) => e.stopPropagation()}
                className="absolute top-2 right-2 bg-black/60 backdrop-blur-sm rounded-[8px] p-1.5 hover:bg-black/80 opacity-0 group-hover/img:opacity-100 transition-opacity"
                title="Download"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </a>
            </div>
          ))}
          {allToolMedia.videos.map((vid, i) => (
            <video key={`tm-vid-${i}`} src={vid.url} controls playsInline preload="none" className="max-w-full rounded-[10px] border border-white/10" />
          ))}
          {allToolMedia.pdfs.map((file, i) => (
            <div key={`tm-pdf-${i}`} className="rounded-[10px] border border-white/10 overflow-hidden">
              <iframe src={file.url} loading="lazy" className="w-full h-[400px] bg-white" title={file.name} />
              <a
                href={file.url}
                download
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-2 px-3 py-2 bg-surface/80 border-t border-white/10 text-[12px] text-text-2 hover:text-text no-underline transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {file.name}
              </a>
            </div>
          ))}
          {allToolMedia.files.map((file, i) => (
            <a
              key={`tm-file-${i}`}
              href={file.url}
              download
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-white/10 bg-surface/60 hover:bg-surface-2 transition-colors text-[13px] text-text-2 hover:text-text no-underline"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              {file.name}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="ml-auto opacity-50">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </a>
          ))}
        </div>
      )}

      {/* Tool access request banners */}
      {!isUser && <ToolRequestBanner
        text={message.text || ''}
        toolOutputs={toolEvents.map((e) => e.output || '').filter(Boolean)}
      />}

      {/* Bookmark indicator */}
      {message.bookmarked && (
        <div className={`flex items-center gap-1 mt-1 px-1 ${isUser ? 'justify-end' : ''}`}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" className="shrink-0 text-amber-400">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
          <span className="text-[10px] text-amber-400/70 font-600">Bookmarked</span>
        </div>
      )}

      {/* Action buttons */}
      <div className={`flex items-center gap-1 mt-1.5 px-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-all duration-200 translate-y-2 md:group-hover:translate-y-0 ${isUser ? 'justify-end' : ''}`}>
        <button
          onClick={handleCopy}
          aria-label="Copy message"
          className="flex items-center gap-1.5 px-2.5 py-1.5 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 rounded-[8px] border-none bg-transparent
            text-[11px] font-500 text-text-3 cursor-pointer hover:text-text-2 hover:bg-white/[0.04] transition-all justify-center md:justify-start"
          style={{ fontFamily: 'inherit' }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          {copied ? 'Copied' : 'Copy'}
        </button>
        {typeof messageIndex === 'number' && onToggleBookmark && (
          <button
            onClick={() => onToggleBookmark(messageIndex)}
            aria-label={message.bookmarked ? 'Remove bookmark' : 'Bookmark message'}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 rounded-[8px] border-none bg-transparent
              text-[11px] font-500 cursor-pointer hover:bg-white/[0.04] transition-all justify-center md:justify-start ${message.bookmarked ? 'text-amber-400' : ''}`}
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill={message.bookmarked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
            {message.bookmarked ? 'Unbookmark' : 'Bookmark'}
          </button>
        )}
        {isUser && typeof messageIndex === 'number' && onEditResend && (
          <button
            onClick={() => { setEditText(message.text); setEditing(true) }}
            aria-label="Edit and resend"
            className="flex items-center gap-1.5 px-2.5 py-1.5 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 rounded-[8px] border-none bg-transparent
              text-[11px] font-500 text-text-3 cursor-pointer hover:text-text-2 hover:bg-white/[0.04] transition-all justify-center md:justify-start"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Edit
          </button>
        )}
        {typeof messageIndex === 'number' && onFork && (
          <button
            onClick={() => onFork(messageIndex)}
            aria-label="Fork conversation from here"
            className="flex items-center gap-1.5 px-2.5 py-1.5 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 rounded-[8px] border-none bg-transparent
              text-[11px] font-500 text-text-3 cursor-pointer hover:text-text-2 hover:bg-white/[0.04] transition-all justify-center md:justify-start"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <circle cx="18" cy="6" r="3" />
              <path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9" />
              <path d="M12 12v3" />
            </svg>
            Fork
          </button>
        )}
        {!isUser && isLast && onRetry && (
          <button
            onClick={onRetry}
            aria-label="Retry message"
            className="flex items-center gap-1.5 px-2.5 py-1.5 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 rounded-[8px] border-none bg-transparent
              text-[11px] font-500 text-text-3 cursor-pointer hover:text-text-2 hover:bg-white/[0.04] transition-all justify-center md:justify-start"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Retry
          </button>
        )}
        {!isUser && typeof messageIndex === 'number' && onTransferToAgent && (
          <div className="relative">
            <button
              onClick={() => setTransferPickerOpen(!transferPickerOpen)}
              aria-label="Transfer to another agent"
              className="flex items-center gap-1.5 px-2.5 py-1.5 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 rounded-[8px] border-none bg-transparent
                text-[11px] font-500 text-text-3 cursor-pointer hover:text-text-2 hover:bg-white/[0.04] transition-all justify-center md:justify-start"
              style={{ fontFamily: 'inherit' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M8 3L4 7l4 4" />
                <path d="M4 7h16" />
                <path d="M16 21l4-4-4-4" />
                <path d="M20 17H4" />
              </svg>
              Transfer
            </button>
            {transferPickerOpen && (
              <TransferAgentPicker
                onSelect={(agentId) => { onTransferToAgent(messageIndex, agentId); setTransferPickerOpen(false) }}
                onClose={() => setTransferPickerOpen(false)}
              />
            )}
          </div>
        )}
      </div>

      {/* Inline edit mode */}
      {editing && (
        <div className={`max-w-[85%] md:max-w-[72%] mt-2 ${isUser ? 'self-end' : ''}`} style={{ animation: 'fade-in 0.2s ease' }}>
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            className="w-full min-h-[80px] p-3 rounded-[12px] bg-surface border border-white/[0.08] text-text text-[14px] resize-y outline-none focus:border-accent-bright/30"
            style={{ fontFamily: 'inherit' }}
          />
          <div className="flex gap-2 mt-2 justify-end">
            <button
              onClick={() => setEditing(false)}
              className="px-3 py-1.5 rounded-[8px] text-[11px] font-600 text-text-3 bg-white/[0.04] hover:bg-white/[0.07] border-none cursor-pointer transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                if (editText.trim() && typeof messageIndex === 'number' && onEditResend) {
                  onEditResend(messageIndex, editText.trim())
                  setEditing(false)
                }
              }}
              className="px-3 py-1.5 rounded-[8px] text-[11px] font-600 text-white bg-accent-bright hover:bg-accent-bright/80 border-none cursor-pointer transition-colors"
            >
              Save & Resend
            </button>
          </div>
        </div>
      )}
    </div>
  )
})
