'use client'

import { memo, useState, useCallback, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Message } from '@/types'
import { useAppStore } from '@/stores/use-app-store'
import { AiAvatar } from '@/components/shared/avatar'
import { CodeBlock } from './code-block'
import { ToolCallBubble } from './tool-call-bubble'
import { ToolRequestBanner } from './tool-request-banner'
import { api } from '@/lib/api-client'

const FILE_PATH_RE = /^(\/[\w./-]+\.\w{1,10})$/
const DIR_PATH_RE = /^(\/[\w./-]+)\/?$/
const PREVIEWABLE_EXT = /\.(html?|svg|css|js|jsx|ts|tsx|json|md|txt|py|sh)$/i
const SERVEABLE_EXT = /\.(html?|svg|css|js|jsx|ts|tsx)$/i

function FilePathChip({ filePath }: { filePath: string }) {
  const canPreview = PREVIEWABLE_EXT.test(filePath)
  const canServe = SERVEABLE_EXT.test(filePath)
  const serveUrl = `/api/files/serve?path=${encodeURIComponent(filePath)}`

  const [serverState, setServerState] = useState<{
    running: boolean; url?: string; loading: boolean; type?: string; framework?: string
  }>({ running: false, loading: false })

  // Check if a server is already running for this path on mount
  useEffect(() => {
    if (!canServe) return
    api<{ running: boolean; url?: string; type?: string }>('POST', '/preview-server', { action: 'status', path: filePath })
      .then((res) => { if (res.running) setServerState({ running: true, url: res.url, type: res.type, loading: false }) })
      .catch((err) => console.error('Dev server check failed:', err))
  }, [filePath, canServe])

  const handleStartServer = async () => {
    setServerState((s) => ({ ...s, loading: true }))
    try {
      const res = await api<{ running: boolean; url?: string; type?: string; framework?: string }>('POST', '/preview-server', { action: 'start', path: filePath })
      setServerState({ running: res.running, url: res.url, type: res.type, framework: res.framework, loading: false })
    } catch {
      setServerState((s) => ({ ...s, loading: false }))
    }
  }

  const handleStopServer = async () => {
    setServerState((s) => ({ ...s, loading: true }))
    try {
      await api('POST', '/preview-server', { action: 'stop', path: filePath })
      setServerState({ running: false, loading: false })
    } catch {
      setServerState((s) => ({ ...s, loading: false }))
    }
  }

  const frameworkLabel = serverState.framework
    ? serverState.framework.charAt(0).toUpperCase() + serverState.framework.slice(1)
    : null

  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[8px] bg-white/[0.06] border border-white/[0.08] font-mono text-[13px]">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="text-text-3/50 shrink-0">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="text-sky-400">{filePath}</span>
      {canPreview && !serverState.running && (
        <a
          href={serveUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-white/[0.06] hover:bg-white/[0.10] text-[10px] font-600 text-text-3 hover:text-text-2 no-underline transition-colors cursor-pointer"
          title="Open file"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
          Open
        </a>
      )}
      {canServe && !serverState.running && (
        <button
          onClick={handleStartServer}
          disabled={serverState.loading}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-[10px] font-600 border-none cursor-pointer transition-colors disabled:opacity-50"
          title="Start preview server — auto-detects npm projects (React, Next, Vite, etc.) and runs the dev command"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          {serverState.loading ? 'Starting...' : 'Serve'}
        </button>
      )}
      {canServe && serverState.running && (
        <>
          {frameworkLabel && (
            <span className="px-1.5 py-0.5 rounded-[4px] bg-indigo-500/15 text-indigo-300 text-[9px] font-700 uppercase tracking-wider">
              {frameworkLabel}
            </span>
          )}
          {serverState.type === 'npm' && (
            <span className="px-1.5 py-0.5 rounded-[4px] bg-amber-500/15 text-amber-300 text-[9px] font-700 uppercase tracking-wider">
              npm
            </span>
          )}
          <a
            href={serverState.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 text-[10px] font-600 no-underline transition-colors"
            title="Open preview server"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" style={{ animation: 'pulse 2s ease infinite' }} />
            {serverState.url}
          </a>
          <button
            onClick={handleStopServer}
            disabled={serverState.loading}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] bg-red-500/15 hover:bg-red-500/25 text-red-400 text-[10px] font-600 border-none cursor-pointer transition-colors disabled:opacity-50"
            title="Stop preview server"
          >
            <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
            Stop
          </button>
        </>
      )}
    </span>
  )
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function relativeTime(ts: number): string {
  const now = Date.now()
  const diff = now - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  const d = new Date(ts)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return fmtTime(ts)
  if (diff < 604_800_000) return d.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function heartbeatSummary(text: string): string {
  const clean = (text || '')
    .replace(/\bHEARTBEAT_OK\b/gi, '')
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

const IMAGE_ATTACH_RE = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i
const PREVIEWABLE_ATTACH_RE = /\.(html?|svg)$/i
const CODE_ATTACH_RE = /\.(js|jsx|ts|tsx|css|json|md|txt|py|sh|rb|go|rs|c|cpp|h|java|yaml|yml|toml|xml|sql|graphql)$/i
const PDF_ATTACH_RE = /\.pdf$/i
const FILE_TYPE_COLORS: Record<string, string> = {
  html: 'text-orange-400', htm: 'text-orange-400', svg: 'text-emerald-400',
  js: 'text-yellow-400', jsx: 'text-yellow-400', ts: 'text-blue-400', tsx: 'text-blue-400',
  py: 'text-green-400', json: 'text-amber-300', css: 'text-purple-400', scss: 'text-pink-400',
  md: 'text-text-2', txt: 'text-text-3', pdf: 'text-red-400',
}

function parseAttachmentUrl(filePath?: string, fileUrl?: string) {
  const url = fileUrl || (filePath ? `/api/uploads/${filePath.split('/').pop()}` : '')
  const rawName = filePath?.split('/').pop() || fileUrl?.split('/').pop() || 'file'
  const filename = rawName.replace(/^[a-f0-9]+-/, '').split('?')[0]
  return { url, filename }
}

function AttachmentChip({ url, filename, isUserMsg }: { url: string; filename: string; isUserMsg?: boolean }) {
  const isImage = IMAGE_ATTACH_RE.test(filename)
  const isCode = CODE_ATTACH_RE.test(filename)
  const isPdf = PDF_ATTACH_RE.test(filename)
  const [lightbox, setLightbox] = useState(false)
  const [codePreview, setCodePreview] = useState<string | null>(null)
  const [codeExpanded, setCodeExpanded] = useState(false)

  if (isImage) {
    return (
      <>
        <img
          src={url} alt="Attached"
          loading="lazy"
          className="max-w-[240px] rounded-[12px] mb-2 border border-white/10 cursor-pointer hover:border-white/25 transition-colors"
          onClick={() => setLightbox(true)}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
        {lightbox && (
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm cursor-pointer"
            onClick={() => setLightbox(false)}
          >
            <img src={url} alt="Preview" className="max-w-[90vw] max-h-[90vh] rounded-[12px] shadow-2xl" />
          </div>
        )}
      </>
    )
  }

  if (isPdf) {
    return (
      <div className="mb-2 rounded-[12px] border border-white/[0.08] bg-[rgba(255,255,255,0.02)] overflow-hidden" style={{ maxWidth: 480 }}>
        <div className="flex items-center gap-3 px-4 py-2.5">
          <div className="flex items-center justify-center w-8 h-8 rounded-[8px] shrink-0 bg-red-500/10 text-red-400">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </div>
          <span className="text-[13px] font-500 truncate flex-1">{filename}</span>
          <a href={url} download={filename} className="text-[11px] font-600 text-text-3 hover:text-text-2 no-underline">Download</a>
        </div>
        <iframe src={url} loading="lazy" className="w-full h-[300px] border-t border-white/[0.06]" title={filename} />
      </div>
    )
  }

  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const colorClass = FILE_TYPE_COLORS[ext] || 'text-text-3'
  const isPreviewable = PREVIEWABLE_ATTACH_RE.test(filename)

  const chipBg = isUserMsg
    ? 'bg-[rgba(0,0,0,0.25)] border-white/[0.12]'
    : 'bg-[rgba(255,255,255,0.04)] border-white/[0.08]'
  const iconBg = isUserMsg ? 'bg-white/[0.12]' : 'bg-white/[0.05]'
  const btnBg = isUserMsg
    ? 'bg-white/[0.12] hover:bg-white/[0.18] text-white/80'
    : 'bg-white/[0.06] hover:bg-white/[0.10] text-text-3'

  const handleCodePreview = async () => {
    if (codePreview !== null) { setCodeExpanded(!codeExpanded); return }
    try {
      const serveUrl = `/api/files/serve?path=${encodeURIComponent(url.replace('/api/uploads/', ''))}`
      const res = await fetch(url.startsWith('/api/files/') ? url : serveUrl)
      if (!res.ok) return
      const text = await res.text()
      setCodePreview(text)
      setCodeExpanded(true)
    } catch {
      // ignore
    }
  }

  return (
    <div className="mb-2">
      <div className={`flex items-center gap-3 px-4 py-2.5 rounded-[12px] border ${chipBg}`}>
        <div className={`flex items-center justify-center w-8 h-8 rounded-[8px] shrink-0 ${iconBg} ${colorClass}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>
        <div className="flex flex-col flex-1 min-w-0">
          <span className={`text-[13px] font-500 truncate ${isUserMsg ? 'text-white' : 'text-text'}`}>{filename}</span>
          <span className={`text-[11px] uppercase tracking-wide ${isUserMsg ? 'text-white/50' : 'text-text-3/70'}`}>{ext || 'file'}</span>
        </div>
        {isCode && (
          <button
            onClick={handleCodePreview}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] text-[11px] font-600 no-underline transition-colors shrink-0 border-none cursor-pointer ${
              isUserMsg ? 'bg-white/[0.15] hover:bg-white/[0.22] text-white' : 'bg-accent-soft hover:bg-accent-soft/80 text-accent-bright'
            }`}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
            {codeExpanded ? 'Hide' : 'Preview'}
          </button>
        )}
        {isPreviewable && (
          <a href={url} target="_blank" rel="noopener noreferrer"
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] text-[11px] font-600 no-underline transition-colors shrink-0 ${
              isUserMsg ? 'bg-white/[0.15] hover:bg-white/[0.22] text-white' : 'bg-accent-soft hover:bg-accent-soft/80 text-accent-bright'
            }`}
            title="Preview in new tab">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            Preview
          </a>
        )}
        <a href={url} download={filename}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] text-[11px] font-600 no-underline transition-colors shrink-0 ${btnBg}`}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Download
        </a>
      </div>
      {isCode && codeExpanded && codePreview !== null && (
        <div className="mt-1 rounded-[10px] border border-white/[0.06] overflow-hidden" style={{ animation: 'fade-in 0.2s ease' }}>
          <CodeBlock className={`language-${ext}`}>
            {codePreview.split('\n').slice(0, codeExpanded ? undefined : 10).join('\n')}
          </CodeBlock>
          {codePreview.split('\n').length > 10 && (
            <button
              onClick={() => setCodeExpanded((v) => !v)}
              className="w-full px-3 py-1.5 text-[10px] text-text-3 hover:text-text-2 bg-white/[0.02] hover:bg-white/[0.04] border-none border-t border-white/[0.06] cursor-pointer transition-colors"
            >
              {codePreview.split('\n').length > 10 ? `Show all ${codePreview.split('\n').length} lines` : 'Show less'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

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
  isLast?: boolean
  onRetry?: () => void
  messageIndex?: number
  onToggleBookmark?: (index: number) => void
  onEditResend?: (index: number, newText: string) => void
  onFork?: (index: number) => void
}

export const MessageBubble = memo(function MessageBubble({ message, assistantName, isLast, onRetry, messageIndex, onToggleBookmark, onEditResend, onFork }: Props) {
  const isUser = message.role === 'user'
  const isHeartbeat = !isUser && (message.kind === 'heartbeat' || /^\s*HEARTBEAT_OK\b/i.test(message.text || ''))
  const currentUser = useAppStore((s) => s.currentUser)
  const [copied, setCopied] = useState(false)
  const [heartbeatExpanded, setHeartbeatExpanded] = useState(false)
  const [toolEventsExpanded, setToolEventsExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')
  const toolEvents = message.toolEvents || []
  const hasToolEvents = !isUser && toolEvents.length > 0
  const visibleToolEvents = toolEventsExpanded ? [...toolEvents].reverse() : toolEvents.slice(-1)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [message.text])

  return (
    <div
      className={`group ${isUser ? 'flex flex-col items-end' : 'flex flex-col items-start'}`}
      style={{ animation: `${isUser ? 'msg-in-right' : 'msg-in-left'} 0.35s cubic-bezier(0.16, 1, 0.3, 1)` }}
    >
      {/* Sender label + timestamp */}
      <div className={`flex items-center gap-2.5 mb-2 px-1 ${isUser ? 'flex-row-reverse' : ''}`}>
        {!isUser && <AiAvatar size="sm" />}
        <span className={`text-[12px] font-600 ${isUser ? 'text-accent-bright/70' : 'text-text-3'}`}>
          {isUser ? (currentUser ? currentUser.charAt(0).toUpperCase() + currentUser.slice(1) : 'You') : (assistantName || 'Claude')}
        </span>
        <span className="text-[11px] text-text-3/70 font-mono" title={message.time ? new Date(message.time).toLocaleString() : ''}>
          {message.time ? relativeTime(message.time) : ''}
        </span>
      </div>

      {/* Tool call events (assistant messages only) */}
      {hasToolEvents && (
        <div className="max-w-[85%] md:max-w-[72%] flex flex-col gap-2 mb-2">
          {toolEvents.length > 1 && (
            <button
              type="button"
              onClick={() => setToolEventsExpanded((v) => !v)}
              className="self-start px-2.5 py-1 rounded-[8px] bg-white/[0.04] hover:bg-white/[0.07] text-[11px] text-text-3 border border-white/[0.06] cursor-pointer transition-colors"
            >
              {toolEventsExpanded ? 'Show latest only' : `Show all tool calls (${toolEvents.length})`}
            </button>
          )}
          <div className={`${toolEventsExpanded ? 'max-h-[320px] overflow-y-auto pr-1 flex flex-col gap-2' : 'flex flex-col gap-2'}`}>
            {visibleToolEvents.map((event, i) => (
              <ToolCallBubble
                key={`${message.time}-tool-${toolEventsExpanded ? `all-${i}` : `latest-${toolEvents.length - 1}`}`}
                event={{
                  id: `${message.time}-${toolEventsExpanded ? i : toolEvents.length - 1}`,
                  name: event.name,
                  input: event.input,
                  output: event.output,
                  status: event.error ? 'error' : 'done',
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Message bubble */}
      <div className={`max-w-[85%] md:max-w-[72%] ${isUser ? 'bubble-user px-5 py-3.5' : isHeartbeat ? 'bubble-ai px-4 py-3' : 'bubble-ai px-5 py-3.5'}`}>
        {renderAttachments(message)}

        {isHeartbeat ? (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setHeartbeatExpanded((v) => !v)}
              className="w-full rounded-[12px] px-3.5 py-3 border border-white/[0.10] bg-white/[0.02] text-left hover:bg-white/[0.04] transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  <span className="text-[11px] uppercase tracking-[0.08em] text-text-2 font-600">Heartbeat</span>
                </div>
                <span className="text-[11px] text-text-3">{heartbeatExpanded ? 'Collapse' : 'Expand'}</span>
              </div>
              <p className="text-[13px] text-text-2/90 leading-[1.5] mt-1.5">{heartbeatSummary(message.text)}</p>
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
                  {message.text}
                </ReactMarkdown>
              </div>
            )}
          </div>
        ) : (
          <div className={`msg-content text-[15px] break-words ${isUser ? 'leading-[1.6] text-white/95' : 'leading-[1.7] text-text'}`}>
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
              {message.text}
            </ReactMarkdown>
          </div>
        )}
      </div>

      {/* Tool access request banners */}
      {!isUser && <ToolRequestBanner
        text={message.text || ''}
        toolOutputs={toolEvents.map((e) => e.output || '').filter(Boolean)}
      />}

      {/* Bookmark indicator */}
      {message.bookmarked && (
        <div className={`flex items-center gap-1 mt-1 px-1 ${isUser ? 'justify-end' : ''}`}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="#F59E0B" stroke="#F59E0B" strokeWidth="2" className="shrink-0">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
          <span className="text-[10px] text-[#F59E0B]/70 font-600">Bookmarked</span>
        </div>
      )}

      {/* Action buttons */}
      <div className={`flex items-center gap-1 mt-1.5 px-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200 ${isUser ? 'justify-end' : ''}`}>
        <button
          onClick={handleCopy}
          aria-label="Copy message"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border-none bg-transparent
            text-[11px] font-500 text-text-3 cursor-pointer hover:text-text-2 hover:bg-white/[0.04] transition-all"
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
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border-none bg-transparent
              text-[11px] font-500 cursor-pointer hover:bg-white/[0.04] transition-all"
            style={{ fontFamily: 'inherit', color: message.bookmarked ? '#F59E0B' : undefined }}
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
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border-none bg-transparent
              text-[11px] font-500 text-text-3 cursor-pointer hover:text-text-2 hover:bg-white/[0.04] transition-all"
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
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border-none bg-transparent
              text-[11px] font-500 text-text-3 cursor-pointer hover:text-text-2 hover:bg-white/[0.04] transition-all"
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
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] border-none bg-transparent
              text-[11px] font-500 text-text-3 cursor-pointer hover:text-text-2 hover:bg-white/[0.04] transition-all"
            style={{ fontFamily: 'inherit' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Retry
          </button>
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
