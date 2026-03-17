'use client'

import { isValidElement, memo, useState, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Message } from '@/types'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import type { ToolEvent } from '@/stores/use-chat-store'
import { AiAvatar } from '@/components/shared/avatar'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { CodeBlock } from './code-block'
import { extractMedia, isExplicitScreenshot } from './tool-call-bubble'
import { ToolEventsSection, ToolActivityPill } from './tool-events-section'
import { MessageAttachments } from '@/components/shared/attachment-chip'
import { MarkdownBody } from '@/components/shared/markdown-body'
import { MessageActions, ActionButton } from '@/components/shared/message-actions'
import { isStructuredMarkdown } from '@/components/shared/markdown-utils'
import { FilePathChip, FILE_PATH_RE, DIR_PATH_RE } from './file-path-chip'
import { TransferAgentPicker } from './transfer-agent-picker'
import { DelegationSourceBanner, TaskCompletionCard, parseTaskCompletion } from './delegation-banner'
import { ConnectorPlatformIcon, getConnectorPlatformLabel } from '@/components/shared/connector-platform-icon'
import { copyTextToClipboard } from '@/lib/clipboard'
import { formatMessageTimestamp } from '@/lib/chat/chat-display'
import { stripAllInternalMetadata } from '@/lib/strip-internal-metadata'

/** Parse delegation-source metadata prefix from system messages */
const DELEGATION_SOURCE_RE = /^\[delegation-source:([^:]*):([^:]*):([^\]]*)\]/
const UPLOAD_IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i
const UPLOAD_VIDEO_RE = /\.(mp4|webm|mov|avi)$/i
const UPLOAD_PDF_RE = /\.pdf$/i

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

function normalizeUploadMediaKey(url: string): string {
  const pathname = String(url || '').split('?')[0]
  const basename = pathname.split('/').pop() || pathname
  return basename.replace(/^\d+-/, '')
}

function extractReferencedUploadMediaKeys(text: string): Set<string> {
  const urls = new Set<string>()
  if (!text) return urls
  for (const match of text.matchAll(/\((\/api\/uploads\/[^)\s]+)\)/g)) {
    const url = match[1]
    if (UPLOAD_IMAGE_RE.test(url) || UPLOAD_VIDEO_RE.test(url) || UPLOAD_PDF_RE.test(url)) {
      urls.add(normalizeUploadMediaKey(url))
    }
  }
  return urls
}

function flattenMarkdownNodeText(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(flattenMarkdownNodeText).join('')
  const candidate = node as { type?: string; value?: unknown; children?: unknown[] }
  if (candidate.type === 'text' && typeof candidate.value === 'string') return candidate.value
  if (!Array.isArray(candidate.children)) return ''
  return candidate.children.map(flattenMarkdownNodeText).join('')
}

function collectInlinePreviewLinks(node: unknown): Array<{ href: string; label: string; type: 'image' | 'video' | 'pdf' }> {
  const links: Array<{ href: string; label: string; type: 'image' | 'video' | 'pdf' }> = []
  const seen = new Set<string>()

  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }

    const candidate = value as {
      type?: string
      tagName?: string
      properties?: Record<string, unknown>
      children?: unknown[]
    }

    if (candidate.type === 'element' && candidate.tagName === 'a') {
      const href = typeof candidate.properties?.href === 'string' ? candidate.properties.href : ''
      const key = normalizeUploadMediaKey(href)
      if (href.startsWith('/api/uploads/') && !seen.has(key)) {
        let type: 'image' | 'video' | 'pdf' | null = null
        if (UPLOAD_IMAGE_RE.test(href)) type = 'image'
        else if (UPLOAD_VIDEO_RE.test(href)) type = 'video'
        else if (UPLOAD_PDF_RE.test(href)) type = 'pdf'
        if (type) {
          seen.add(key)
          links.push({
            href,
            label: flattenMarkdownNodeText(candidate.children || []).trim() || 'Download',
            type,
          })
        }
      }
    }

    if (Array.isArray(candidate.children)) {
      candidate.children.forEach(visit)
    }
  }

  visit(node)
  return links
}

const STATUS_COLORS: Record<string, string> = {
  progress: '#F59E0B',
  ok: '#22C55E',
  idle: '#6B7280',
  blocked: '#EF4444',
}

const emptyToolEvents: NonNullable<Message['toolEvents']> = []
const emptyLiveToolEvents: ToolEvent[] = []

interface LiveStreamState {
  active: boolean
  phase: 'queued' | 'thinking' | 'tool' | 'responding' | 'connecting'
  toolName: string
  text: string
  thinking: string
  toolEvents: ToolEvent[]
}

type ToolMediaEntryKind = 'image' | 'video' | 'pdf' | 'file'

interface ToolMediaEntry {
  kind: ToolMediaEntryKind
  name: string
  url: string
}

// AttachmentChip, parseAttachmentUrl, regex constants, and FILE_TYPE_COLORS
// are now imported from @/components/shared/attachment-chip

function countDisplayParagraphs(text: string): number {
  return text
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .length
}

function normalizeLiveStreamingMarkdown(text: string, options: { active: boolean; structured: boolean }): string {
  if (!options.active || options.structured || !text) return text
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized.includes('\n') || /\n\s*\n/.test(normalized)) return normalized
  return normalized.replace(/\n+/g, '\n\n')
}

function renderToolMediaEntry(
  media: ToolMediaEntry,
  key: string,
  onOpenImage?: (image: { url: string; name: string }) => void,
) {
  if (media.kind === 'image') {
    return (
      <div key={key} className="relative group/img">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={media.url}
          alt={media.name}
          loading="lazy"
          className="max-w-[400px] rounded-[10px] border border-white/10 cursor-pointer hover:border-white/25 transition-all"
          onClick={() => onOpenImage?.({ url: media.url, name: media.name })}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
        <a
          href={media.url}
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
    )
  }

  if (media.kind === 'video') {
    return (
      <video
        key={key}
        src={media.url}
        controls
        playsInline
        preload="none"
        className="max-w-full rounded-[10px] border border-white/10"
      />
    )
  }

  if (media.kind === 'pdf') {
    return (
      <div key={key} className="rounded-[10px] border border-white/10 overflow-hidden">
        <iframe src={media.url} loading="lazy" className="w-full h-[400px] bg-white" title={media.name} />
        <a
          href={media.url}
          download
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-2 px-3 py-2 bg-surface/80 border-t border-white/10 text-[12px] text-text-2 hover:text-text no-underline transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {media.name}
        </a>
      </div>
    )
  }

  return (
    <a
      key={key}
      href={media.url}
      download
      onClick={(e) => e.stopPropagation()}
      className="flex items-center gap-2 px-3 py-2 rounded-[10px] border border-white/10 bg-surface/60 hover:bg-surface-2 transition-colors text-[13px] text-text-2 hover:text-text no-underline"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      {media.name}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="ml-auto opacity-50">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </a>
  )
}

interface Props {
  message: Message
  assistantName?: string
  agentAvatarSeed?: string
  agentAvatarUrl?: string | null
  agentName?: string
  cwd?: string
  liveStream?: LiveStreamState
  isLast?: boolean
  onRetry?: () => void
  messageIndex?: number
  onToggleBookmark?: (index: number) => void
  onEditResend?: (index: number, newText: string) => void
  onTransferToAgent?: (messageIndex: number, agentId: string) => void
  momentOverlay?: React.ReactNode
}

export const MessageBubble = memo(function MessageBubble({ message, assistantName, agentAvatarSeed, agentAvatarUrl, agentName, cwd, liveStream, isLast, onRetry, messageIndex, onToggleBookmark, onEditResend, onTransferToAgent, momentOverlay }: Props) {
  const isUser = message.role === 'user'
  const isHeartbeat = !isUser && (message.kind === 'heartbeat' || /^\s*HEARTBEAT_OK\b/i.test(message.text || ''))
  const isExtensionUI = !isUser && message.kind === 'extension-ui'
  const scaffoldRequest = useMemo(() => {
    if (isUser) return null
    try {
      const data = JSON.parse(message.text)
      if (data.type === 'extension_scaffold_result') return data
    } catch { /* ignore */ }
    return null
  }, [message.text, isUser])

  const installRequest = useMemo(() => {
    if (isUser) return null
    try {
      const data = JSON.parse(message.text)
      if (data.type === 'extension_install_result') return data
    } catch { /* ignore */ }
    return null
  }, [message.text, isUser])

  const walletRequest = useMemo(() => {
    if (isUser) return null
    try {
      const data = JSON.parse(message.text)
      if (data.type === 'extension_wallet_transfer_request') return data
    } catch { /* ignore */ }
    return null
  }, [message.text, isUser])

  const walletActionRequest = useMemo(() => {
    if (isUser) return null
    try {
      const data = JSON.parse(message.text)
      if (data.type === 'extension_wallet_action_request') return data
    } catch { /* ignore */ }
    return null
  }, [message.text, isUser])
  const currentUser = useAppStore((s) => s.currentUser)
  const isDesktop = useMediaQuery('(min-width: 768px)')
  const setPreviewContent = useChatStore((s) => s.setPreviewContent)
  const [copied, setCopied] = useState(false)
  const [heartbeatExpanded, setHeartbeatExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const [transferPickerOpen, setTransferPickerOpen] = useState(false)
  const liveStreamActive = !isUser && liveStream?.active === true
  const liveToolEvents = liveStream?.toolEvents ?? emptyLiveToolEvents
  const toolEvents = message.toolEvents ?? emptyToolEvents
  const toolEventsForMedia = useMemo(
    () => (liveStreamActive
      ? (liveToolEvents.length > 0
          ? liveToolEvents.map((event) => ({
              name: event.name,
              input: event.input,
              output: event.output,
              error: event.status === 'error' || undefined,
            }))
          : toolEvents)
      : toolEvents),
    [liveStreamActive, liveToolEvents, toolEvents],
  )
  // Separate send_file events — they render as inline attachments, not in the tool accordion
  const persistedToolEvents = useMemo(
    () => toolEvents.filter((ev) => ev.name !== 'send_file' || ev.error),
    [toolEvents],
  )
  const displayToolEvents = useMemo(
    () => (liveStreamActive
      ? (liveToolEvents.length > 0
          ? liveToolEvents.filter((ev) => ev.name !== 'send_file' || ev.status === 'error')
          : persistedToolEvents.map((ev, i) => ({
              id: ev.toolCallId || `${message.time}-${ev.name}-${i}`,
              name: ev.name,
              input: ev.input,
              output: ev.output,
              status: ev.error ? 'error' as const : 'done' as const,
            })))
      : persistedToolEvents.map((ev, i) => ({
          id: ev.toolCallId || `${message.time}-${ev.name}-${i}`,
          name: ev.name,
          input: ev.input,
          output: ev.output,
          status: ev.error ? 'error' as const : 'done' as const,
        }))),
    [liveStreamActive, liveToolEvents, message.time, persistedToolEvents],
  )
  const hasToolEvents = !isUser && displayToolEvents.length > 0

  // Tool pill open/close state (lifted from ToolEventsSection)
  const [toolSectionOpen, setToolSectionOpen] = useState(false)
  const [toolUserToggled, setToolUserToggled] = useState(false)

  // Auto-expand when tools start running (mirrors old ToolEventsSection behavior)
  const toolRunningCount = useMemo(() => {
    let c = 0
    for (const ev of displayToolEvents) if (ev.status === 'running') c++
    return c
  }, [displayToolEvents])

  // Derive effective open state instead of setState during render
  const effectiveToolSectionOpen = toolSectionOpen || (!toolUserToggled && toolRunningCount > 0)

  const handleToolPillToggle = useCallback(() => {
    setToolUserToggled(true)
    setToolSectionOpen((v) => !v)
  }, [])


  const effectiveThinking = !isUser
    ? (liveStreamActive ? (liveStream?.thinking?.trim() ? liveStream.thinking : undefined) : message.thinking)
    : undefined

  const sourceText = liveStreamActive ? (liveStream?.text || message.text || '') : message.text
  const connectorDeliveryTranscript = !isUser && message.kind === 'connector-delivery'
    ? (message.source?.deliveryTranscript?.trim() || '')
    : ''
  const copySourceText = connectorDeliveryTranscript || (liveStreamActive ? (liveStream?.text || message.text || '') : message.text)

  // Extract ALL media from ALL tool events for inline display after the message text.
  // Covers send_file, browser screenshots, file tool outputs — everything.
  const allToolMedia = useMemo(() => {
    const ordered: ToolMediaEntry[] = []
    const seen = new Set<string>()

    for (const ev of toolEventsForMedia) {
      if (ev.error || !ev.output) continue
      if (!isExplicitScreenshot(ev.name, ev.input)) continue
      const m = extractMedia(ev.output)
      for (const url of m.images) {
        if (!seen.has(url)) {
          seen.add(url)
          ordered.push({ kind: 'image', name: url.split('/').pop() || 'Image', url })
        }
      }
      for (const url of m.videos) {
        if (!seen.has(url)) {
          seen.add(url)
          ordered.push({ kind: 'video', name: url.split('/').pop() || 'Video', url })
        }
      }
      for (const p of m.pdfs) {
        if (!seen.has(p.url)) {
          seen.add(p.url)
          ordered.push({ kind: 'pdf', name: p.name, url: p.url })
        }
      }
      for (const f of m.files) {
        // Reclassify image-extension files as images (send_file uses [label](url) not ![](url))
        if (/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(f.url)) {
          if (!seen.has(f.url)) {
            seen.add(f.url)
            ordered.push({ kind: 'image', name: f.name, url: f.url })
          }
        } else {
          if (!seen.has(f.url)) {
            seen.add(f.url)
            ordered.push({ kind: 'file', name: f.name, url: f.url })
          }
        }
      }
    }

    return ordered.length > 0 ? ordered : null
  }, [toolEventsForMedia])
  const isStructured = !isUser && !isHeartbeat && isStructuredMarkdown(sourceText)

  // Collect all media URLs already rendered via tool events to avoid duplicates in markdown
  const toolEventMediaUrls = useMemo(() => {
    if (!toolEventsForMedia.length) return null
    const urls = new Set<string>()
    for (const ev of toolEventsForMedia) {
      if (!ev.output) continue
      const m = extractMedia(ev.output)
      for (const url of m.images) urls.add(url)
      for (const url of m.videos) urls.add(url)
    }
    return urls.size > 0 ? urls : null
  }, [toolEventsForMedia])

  // Detect delegation-source system messages
  const delegationSource = !isUser && message.kind === 'system' ? parseDelegationSource(message.text || '') : null
  // Detect task completion system messages (delegated or direct)
  const taskCompletion = !isUser && message.kind === 'system' ? parseTaskCompletion(message.text || '') : null
  const rawDisplayText = connectorDeliveryTranscript || (delegationSource ? delegationSource.rest : sourceText)
  const displayText = rawDisplayText
    ? stripAllInternalMetadata(
        rawDisplayText.split('\n')
          .filter((l) => !/\[(MAIN_LOOP_META|MAIN_LOOP_PLAN|MAIN_LOOP_REVIEW|AGENT_HEARTBEAT_META)\]/.test(l))
          .join('\n'),
      )
    : ''
  const hasDisplayText = displayText.length > 0
  const normalizedDisplayText = useMemo(
    () => normalizeLiveStreamingMarkdown(displayText, { active: liveStreamActive, structured: isStructured }),
    [displayText, isStructured, liveStreamActive],
  )
  const referencedUploadMediaKeys = useMemo(
    () => extractReferencedUploadMediaKeys(displayText),
    [displayText],
  )
  const unreferencedToolMedia = useMemo(() => {
    if (!allToolMedia) return null
    const filtered = allToolMedia.filter((media) => (
      media.kind === 'file'
        ? true
        : !referencedUploadMediaKeys.has(normalizeUploadMediaKey(media.url))
    ))
    return filtered.length > 0 ? filtered : null
  }, [allToolMedia, referencedUploadMediaKeys])

  const liveInlineToolMedia = useMemo(() => {
    if (!liveStreamActive || !unreferencedToolMedia || referencedUploadMediaKeys.size > 0 || !hasDisplayText) return null
    const inlineCount = Math.min(unreferencedToolMedia.length, countDisplayParagraphs(normalizedDisplayText))
    return inlineCount > 0 ? unreferencedToolMedia.slice(0, inlineCount) : null
  }, [hasDisplayText, liveStreamActive, normalizedDisplayText, referencedUploadMediaKeys, unreferencedToolMedia])

  const trailingToolMedia = useMemo(() => {
    if (!unreferencedToolMedia) return null
    if (!liveInlineToolMedia) return unreferencedToolMedia
    const remaining = unreferencedToolMedia.slice(liveInlineToolMedia.length)
    return remaining.length > 0 ? remaining : null
  }, [liveInlineToolMedia, unreferencedToolMedia])

  const handleOpenAttachmentImage = useCallback(({ url, filename }: { url: string; filename: string }) => {
    setPreviewContent({ type: 'image', url, title: filename })
  }, [setPreviewContent])

  const handleOpenToolMediaImage = useCallback(({ url, name }: { url: string; name: string }) => {
    setPreviewContent({ type: 'image', url, title: name })
  }, [setPreviewContent])

  const handleCopy = useCallback(() => {
    void copyTextToClipboard(copySourceText).then((copiedText) => {
      if (!copiedText) return
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [copySourceText])

  const connectorMeta = connectorThreadMeta(message, isUser)
  const hasPrimaryAttachments = Boolean(message.imagePath || message.imageUrl || message.attachedFiles?.length)
  const shouldRenderBubbleShell = hasPrimaryAttachments
    || Boolean(allToolMedia)
    || Boolean(walletRequest)
    || Boolean(walletActionRequest)
    || Boolean(installRequest)
    || Boolean(scaffoldRequest)
    || isExtensionUI
    || isHeartbeat
    || hasDisplayText
  const canCopy = copySourceText.trim().length > 0
  const showActions = canCopy
    || (typeof messageIndex === 'number' && Boolean(onToggleBookmark))
    || (isUser && typeof messageIndex === 'number' && Boolean(onEditResend))
    || (!isUser && isLast && Boolean(onRetry))
    || (!isUser && typeof messageIndex === 'number' && Boolean(onTransferToAgent))
  const safeMomentOverlay = isValidElement(momentOverlay) ? momentOverlay : null

  return (
    <div
      data-testid="message-bubble"
      data-message-role={message.role}
      data-message-kind={message.kind || 'chat'}
      data-message-time={message.time || undefined}
      data-message-has-tools={hasToolEvents || undefined}
      className={`group ${isUser ? 'flex flex-col items-end' : 'flex flex-col items-start relative pl-[44px]'}`}
    >
      {/* Avatar on spine (assistant) */}
      {!isUser && (
        <div className="absolute left-[4px] top-0">
          <div style={safeMomentOverlay ? { animation: 'avatar-moment-pulse 0.6s ease' } : undefined}>
            {agentName
              ? <AgentAvatar seed={agentAvatarSeed || null} avatarUrl={agentAvatarUrl} name={agentName} size={28} />
              : <AiAvatar size="sm" mood={liveStream?.phase === 'tool' ? 'tool' : liveStreamActive ? 'thinking' : undefined} />}
          </div>
          {safeMomentOverlay}
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
          {hasToolEvents && (
            <ToolActivityPill
              toolEvents={displayToolEvents}
              isOpen={effectiveToolSectionOpen}
              onToggle={handleToolPillToggle}
            />
          )}
          {!isUser && liveStreamActive && (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-accent-bright/10 border border-accent-bright/15"
              style={{ animation: 'pulse-subtle 2s ease-in-out infinite' }}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                liveStream?.phase === 'queued' ? 'bg-amber-400' : 'bg-accent-bright'
              }`} style={{ animation: 'pulse 1.5s ease infinite' }} />
              <span className="text-[10px] text-accent-bright/80 font-mono font-600">
                {liveStream?.phase === 'queued' ? 'Queued...'
                  : liveStream?.phase === 'tool' && liveStream.toolName ? `Using ${liveStream.toolName}...`
                  : liveStream?.phase === 'responding' ? 'Responding...'
                  : liveStream?.phase === 'connecting' ? 'Reconnecting...'
                  : 'Thinking...'}
              </span>
            </span>
          )}
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

      {/* Tool events expanded card (controlled by pill toggle) */}
      {hasToolEvents && effectiveToolSectionOpen && (
        <div className="max-w-[85%] md:max-w-[72%] mb-2" data-testid="tool-activity">
          <div className="rounded-[16px] border border-white/[0.08] bg-surface/72 backdrop-blur-sm overflow-hidden">
            <ToolEventsSection toolEvents={displayToolEvents} controlled />
          </div>
        </div>
      )}


      {/* Thinking block (collapsible, shown for assistant messages with persisted thinking) */}
      {!isUser && effectiveThinking && (
        <div className="max-w-[85%] md:max-w-[72%] mb-2">
          <details className="group rounded-[12px] border border-purple-500/15 bg-purple-500/[0.04]">
            <summary className="flex items-center gap-2 px-3.5 py-2.5 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-purple-400/60 shrink-0 transition-transform group-open:rotate-90">
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <span className="text-[11px] font-600 text-purple-400/70 uppercase tracking-[0.05em]">Thinking</span>
              {!liveStreamActive && (
                <span className="text-[10px] text-text-3/40 font-mono">{Math.ceil(effectiveThinking.length / 4)} tokens</span>
              )}
            </summary>
            <div className="px-3.5 pb-3 pt-1 max-h-[300px] overflow-y-auto">
              <div className="text-[13px] leading-[1.6] text-text-3/70 whitespace-pre-wrap break-words">
                {effectiveThinking}
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
      ) : shouldRenderBubbleShell ? (
        /* Message bubble */
        <div className={`${isStructured ? 'max-w-[92%] md:max-w-[85%]' : 'max-w-[85%] md:max-w-[72%]'} ${isUser ? 'bubble-user px-5 py-3.5' : isHeartbeat ? 'bubble-ai px-4 py-3' : 'bubble-ai px-5 py-3.5'}`}>
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
              <span className="text-[11px] font-700 uppercase tracking-wider text-emerald-400/80">Extension Installed</span>
            </div>
            <p className="text-[13px] text-text-2/90 leading-relaxed">{installRequest.message}</p>
            <div className="p-3 rounded-[12px] bg-black/40 border border-white/5 flex flex-col gap-1">
              <div className="text-[11px] text-text-3/60 font-600 uppercase tracking-tight">Extension</div>
              <div className="text-[12px] font-mono text-emerald-200/70">{installRequest.filename || installRequest.extensionId || 'extension'}</div>
              <div className="text-[11px] text-text-3/60 font-600 uppercase tracking-tight mt-2">Source URL</div>
              <div className="text-[12px] font-mono text-emerald-200/70 truncate">{installRequest.url}</div>
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
              <span className="text-[11px] font-700 uppercase tracking-wider text-amber-400/80">Extension Created</span>
            </div>
            <p className="text-[13px] text-text-2/90 leading-relaxed">{scaffoldRequest.message}</p>
            <div className="p-3 rounded-[12px] bg-black/40 border border-white/5">
              <div className="text-[11px] font-mono text-text-3/60 mb-2 border-b border-white/5 pb-1">filename: {scaffoldRequest.filename}</div>
              {scaffoldRequest.filePath && (
                <div className="text-[12px] font-mono text-amber-200/70 break-all">
                  {scaffoldRequest.filePath}
                </div>
              )}
            </div>
          </div>
        ) : isExtensionUI ? (
          <div className="flex flex-col gap-2 p-4 rounded-[18px] bg-emerald-500/[0.03] border border-emerald-500/10 shadow-[0_0_20px_rgba(16,185,129,0.05)]">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
              </div>
              <span className="text-[11px] font-700 uppercase tracking-wider text-emerald-400/80">Extension UI Extension</span>
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
        ) : hasDisplayText ? (
          <div className={`msg-content text-[15px] md:text-[14px] break-words ${liveStreamActive ? 'streaming-cursor' : ''} ${isUser ? 'leading-[1.6] text-white/95' : 'leading-[1.7] text-text'}`}>
            {!isUser && message.kind === 'connector-delivery' && connectorDeliveryTranscript && (
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[11px] font-700 uppercase tracking-[0.12em] text-emerald-200/85">
                <span>Delivered via connector</span>
                {message.source?.deliveryMode === 'voice_note' && (
                  <span className="text-emerald-100/70">voice note</span>
                )}
              </div>
            )}
            {(() => {
              let liveInlineToolMediaIndex = 0
              return (
                <MarkdownBody
                  text={normalizedDisplayText}
                  skipMediaUrls={toolEventMediaUrls || undefined}
                  renderParagraph={(node, children) => {
                    const previews = collectInlinePreviewLinks(node)
                    const streamedInlineMedia = previews.length === 0
                      ? liveInlineToolMedia?.[liveInlineToolMediaIndex++] ?? null
                      : null
                    if (previews.length === 0 && !streamedInlineMedia) return null // use default <p>
                    return (
                      <>
                        <p>{children}</p>
                        <div className="mt-3 mb-1 flex flex-col gap-3">
                          {previews.map((preview) => (
                            <span key={`${preview.type}:${preview.href}`} className="block max-w-full">
                              {preview.type === 'image' && (
                                <a href={preview.href} download target="_blank" rel="noopener noreferrer" className="block max-w-full">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={preview.href}
                                    alt={preview.label}
                                    loading="lazy"
                                    className="max-w-[400px] rounded-[10px] border border-white/10 hover:border-white/25 transition-colors"
                                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                                  />
                                </a>
                              )}
                              {preview.type === 'video' && (
                                <video src={preview.href} controls playsInline preload="none" className="max-w-full rounded-[10px] border border-white/10" />
                              )}
                              {preview.type === 'pdf' && (
                                <span className="block w-full max-w-[520px] overflow-hidden rounded-[10px] border border-white/10">
                                  <iframe src={preview.href} loading="lazy" className="h-[360px] w-full bg-white" title={preview.label} />
                                </span>
                              )}
                            </span>
                          ))}
                          {streamedInlineMedia && renderToolMediaEntry(
                            streamedInlineMedia,
                            `inline-tool-media-${liveInlineToolMediaIndex}-${streamedInlineMedia.url}`,
                            handleOpenToolMediaImage,
                          )}
                        </div>
                      </>
                    )
                  }}
                  renderInlineCode={(text) => {
                    if (text && (FILE_PATH_RE.test(text) || (DIR_PATH_RE.test(text) && text.split('/').length > 2))) {
                      return <FilePathChip filePath={text.replace(/\/$/, '')} cwd={cwd} />
                    }
                    return null
                  }}
                  renderLink={(href, children) => {
                    // Internal app links: #task:<id>
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
                    // #schedule:<id>
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
                    // Upload links (agent chat has richer handling than default)
                    const isUpload = href.startsWith('/api/uploads/')
                    if (isUpload) {
                      const uploadPath = href.split('?')[0]
                      const uploadIsHtml = /\.(html?)$/i.test(uploadPath)
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
                    return null // fall through to MarkdownBody defaults
                  }}
                />
              )
            })()}
          </div>
          ) : null
          }

          <MessageAttachments
            imagePath={message.imagePath}
            imageUrl={message.imageUrl}
            attachedFiles={message.attachedFiles}
            isUser={isUser}
            onOpenImage={isDesktop ? handleOpenAttachmentImage : undefined}
          />

          {trailingToolMedia && (
            <div className={`flex flex-col gap-2 ${hasDisplayText || hasPrimaryAttachments ? 'mt-3' : ''}`}>
              {trailingToolMedia.map((media, i) => renderToolMediaEntry(media, `tm-${i}-${media.url}`, handleOpenToolMediaImage))}
            </div>
          )}
        </div>
      ) : null}

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
      {showActions && (
        <MessageActions layout="bubble" align={isUser ? 'end' : 'start'}>
          {canCopy && (
            <ActionButton
              onClick={handleCopy}
              title="Copy message"
              icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>}
              label={copied ? 'Copied' : 'Copy'}
            />
          )}
          {typeof messageIndex === 'number' && onToggleBookmark && (
            <ActionButton
              onClick={() => onToggleBookmark(messageIndex)}
              title={message.bookmarked ? 'Remove bookmark' : 'Bookmark message'}
              active={message.bookmarked}
              activeClassName="text-amber-400"
              icon={<svg width="12" height="12" viewBox="0 0 24 24" fill={message.bookmarked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>}
              label={message.bookmarked ? 'Unbookmark' : 'Bookmark'}
            />
          )}
          {isUser && typeof messageIndex === 'number' && onEditResend && (
            <ActionButton
              onClick={() => { setEditText(message.text); setEditing(true) }}
              title="Edit and resend"
              icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>}
              label="Edit"
            />
          )}
          {!isUser && isLast && onRetry && (
            <ActionButton
              onClick={onRetry}
              title="Retry message"
              icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>}
              label="Retry"
            />
          )}
          {!isUser && typeof messageIndex === 'number' && onTransferToAgent && (
            <div className="relative">
              <ActionButton
                onClick={() => setTransferPickerOpen(!transferPickerOpen)}
                title="Transfer to another agent"
                icon={<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 3L4 7l4 4" /><path d="M4 7h16" /><path d="M16 21l4-4-4-4" /><path d="M20 17H4" /></svg>}
                label="Transfer"
              />
              {transferPickerOpen && (
                <TransferAgentPicker
                  onSelect={(agentId) => { onTransferToAgent(messageIndex, agentId); setTransferPickerOpen(false) }}
                  onClose={() => setTransferPickerOpen(false)}
                />
              )}
            </div>
          )}
        </MessageActions>
      )}

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
