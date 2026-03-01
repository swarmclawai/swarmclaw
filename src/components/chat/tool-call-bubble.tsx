'use client'

import { useState, useMemo } from 'react'
import type { ToolEvent } from '@/stores/use-chat-store'
import { useChatStore } from '@/stores/use-chat-store'
import { useAppStore } from '@/stores/use-app-store'

const TOOL_COLORS: Record<string, string> = {
  execute_command: '#F59E0B',
  read_file: '#10B981',
  write_file: '#10B981',
  list_files: '#10B981',
  copy_file: '#10B981',
  move_file: '#10B981',
  delete_file: '#EF4444',
  edit_file: '#10B981',
  send_file: '#10B981',
  create_document: '#10B981',
  create_spreadsheet: '#10B981',
  web_search: '#3B82F6',
  web_fetch: '#3B82F6',
  delegate_to_agent: '#6366F1',
  delegate_to_claude_code: '#6366F1',
  delegate_to_codex_cli: '#0EA5E9',
  delegate_to_opencode_cli: '#14B8A6',
  whoami_tool: '#8B5CF6',
  connector_message_tool: '#EC4899',
  search_history_tool: '#8B5CF6',
  manage_tasks: '#EC4899',
  manage_schedules: '#EC4899',
  manage_agents: '#EC4899',
  manage_skills: '#EC4899',
  manage_documents: '#EC4899',
  manage_webhooks: '#EC4899',
  manage_connectors: '#EC4899',
  manage_sessions: '#EC4899',
  memory: '#A855F7',
  browser: '#3B82F6',
}

/** Sub-labels for browser actions shown after the main "Browser" label */
const BROWSER_ACTION_LABELS: Record<string, string> = {
  navigate: 'Navigate',
  screenshot: 'Screenshot',
  snapshot: 'Snapshot',
  click: 'Click',
  type: 'Type',
  press_key: 'Key Press',
  select: 'Select',
  evaluate: 'Run JS',
  pdf: 'Save PDF',
  upload: 'Upload',
  wait: 'Wait',
}

export const TOOL_LABELS: Record<string, string> = {
  execute_command: 'Shell',
  read_file: 'Read File',
  write_file: 'Write File',
  list_files: 'List Files',
  copy_file: 'Copy File',
  move_file: 'Move File',
  delete_file: 'Delete File',
  edit_file: 'Edit File',
  send_file: 'Send File',
  create_document: 'Create Document',
  create_spreadsheet: 'Create Spreadsheet',
  web_search: 'Web Search',
  web_fetch: 'Web Fetch',
  claude_code: 'Claude Code',
  codex_cli: 'Codex CLI',
  opencode_cli: 'OpenCode CLI',
  delegate_to_agent: 'Agent Delegation',
  delegate_to_claude_code: 'Claude Code',
  delegate_to_codex_cli: 'Codex CLI',
  delegate_to_opencode_cli: 'OpenCode CLI',
  whoami_tool: 'Who Am I',
  connector_message_tool: 'Connector Message',
  search_history_tool: 'Search History',
  manage_tasks: 'Tasks',
  manage_schedules: 'Schedules',
  manage_agents: 'Agents',
  manage_skills: 'Skills',
  manage_documents: 'Documents',
  manage_webhooks: 'Webhooks',
  manage_connectors: 'Connectors',
  manage_sessions: 'Chats',
  memory: 'Memory',
  browser: 'Browser',
}

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  execute_command: 'Run shell commands in the working directory',
  read_file: 'Read file contents from disk',
  write_file: 'Write or create files on disk',
  list_files: 'List files and directories',
  copy_file: 'Copy a file to another path',
  move_file: 'Move or rename a file',
  delete_file: 'Delete files or directories (when explicitly enabled)',
  edit_file: 'Edit existing files with find-and-replace',
  send_file: 'Send files to the user (images, PDFs, videos, documents, etc.)',
  create_document: 'Render markdown content into PDF, HTML, or image',
  create_spreadsheet: 'Create Excel or CSV files from structured data',
  web_search: 'Search the web for information',
  web_fetch: 'Fetch and read web page content',
  claude_code: 'Enable delegation to Claude Code CLI',
  codex_cli: 'Enable delegation to OpenAI Codex CLI',
  opencode_cli: 'Enable delegation to OpenCode CLI',
  delegate_to_agent: 'Delegate a task to another agent',
  delegate_to_claude_code: 'Delegate complex coding tasks to Claude Code',
  delegate_to_codex_cli: 'Delegate complex coding tasks to Codex CLI',
  delegate_to_opencode_cli: 'Delegate complex coding tasks to OpenCode CLI',
  whoami_tool: 'Reveal the current agent and chat context',
  connector_message_tool: 'Send proactive outbound messages via running connectors',
  search_history_tool: 'Search chat history for relevant prior context',
  manage_tasks: 'Create, update, and manage tasks on the board',
  manage_schedules: 'Create and manage cron schedules',
  manage_agents: 'Create and configure other agents',
  manage_skills: 'Create and manage agent skills',
  manage_documents: 'Upload and search indexed documents',
  manage_webhooks: 'Register and manage inbound webhooks',
  manage_connectors: 'Manage chat platform connectors (Slack, Discord, etc.)',
  manage_sessions: 'Create and manage agent chats',
  memory: 'Store and recall information across conversations',
  browser: 'Browse the web, take screenshots, and interact with pages',
}

/**
 * Recursively parse stringified JSON values so nested escaped JSON
 * like `"{\"title\": \"Test\"}"` becomes a proper object.
 */
function deepParseJson(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed === 'object' && parsed !== null) {
        return deepParseJson(parsed)
      }
      return parsed
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) {
    return value.map(deepParseJson)
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      result[k] = deepParseJson(v)
    }
    return result
  }
  return value
}

/** Pretty-print JSON, recursively parsing stringified nested values */
function formatJson(raw: string): string {
  try {
    const parsed = deepParseJson(JSON.parse(raw))
    return JSON.stringify(parsed, null, 2)
  } catch {
    return raw
  }
}

/** Extract a human-readable preview from tool input */
function getInputPreview(name: string, input: string): string {
  try {
    let parsed = JSON.parse(input)
    // Unwrap LangChain's { input: ... } wrapper
    if (parsed.input && Object.keys(parsed).length === 1) {
      const inner = parsed.input
      if (typeof inner === 'string') {
        try { parsed = JSON.parse(inner) } catch { parsed = inner }
      } else if (typeof inner === 'object' && inner !== null) {
        parsed = inner
      }
    }

    // Consolidated browser tool — show action + relevant detail
    if (name === 'browser') {
      const act = parsed.action || ''
      if (act === 'navigate') return parsed.url || ''
      if (act === 'click') return parsed.element || (parsed.ref ? `element #${parsed.ref}` : '')
      if (act === 'type') return parsed.text ? `"${parsed.text.slice(0, 50)}"` : ''
      if (act === 'press_key') return parsed.key || ''
      if (act === 'select') return parsed.option || ''
      if (act === 'evaluate') return parsed.expression?.slice(0, 60) || ''
      if (act === 'wait') return parsed.text ? `for "${parsed.text}"` : `${parsed.timeout || 30000}ms`
      if (act === 'upload') return parsed.paths?.join(', ')?.slice(0, 60) || ''
      return ''
    }
    if (name === 'send_file') return parsed.filePath || ''
    if (name === 'delegate_to_agent') return `${parsed.agentName}: ${(parsed.task || '').slice(0, 80)}`

    if (parsed.command) return parsed.command
    if (parsed.filePath) return parsed.filePath
    if (parsed.dirPath) return parsed.dirPath
    if (parsed.query) return parsed.query
    if (parsed.url) return parsed.url
    if (parsed.task) return parsed.task.slice(0, 80)
    if (parsed.action) {
      const detail = parsed.data?.title || parsed.data?.name || parsed.data?.content?.slice(0, 40) || parsed.id || ''
      return detail ? `${parsed.action}: ${detail}` : parsed.action
    }
    const keys = Object.keys(parsed)
    if (keys.length === 1) {
      const val = parsed[keys[0]]
      const str = typeof val === 'string' ? val : JSON.stringify(val)
      return `${keys[0]}: ${str.slice(0, 60)}`
    }
    if (keys.length <= 3) return keys.join(', ')
    return `${keys.slice(0, 2).join(', ')} +${keys.length - 2} more`
  } catch {
    return input.slice(0, 80)
  }
}

/** Extract embedded images, videos, PDFs, and file links from tool output */
function extractMedia(output: string): { images: string[]; videos: string[]; pdfs: { name: string; url: string }[]; files: { name: string; url: string }[]; cleanText: string } {
  const images: string[] = []
  const videos: string[] = []
  const pdfs: { name: string; url: string }[] = []
  const files: { name: string; url: string }[] = []

  // Extract ![alt](/api/uploads/filename) — detect videos vs images by extension
  let cleanText = output.replace(/!\[([^\]]*)\]\(\/api\/uploads\/([^)]+)\)/g, (_match, _alt, filename) => {
    const url = `/api/uploads/${filename}`
    if (/\.(mp4|webm|mov|avi)$/i.test(filename)) {
      videos.push(url)
    } else {
      images.push(url)
    }
    return ''
  })

  // Extract [label](/api/uploads/filename) — separate PDFs for inline preview
  cleanText = cleanText.replace(/\[([^\]]*)\]\(\/api\/uploads\/([^)]+)\)/g, (_match, label, filename) => {
    const url = `/api/uploads/${filename}`
    if (/\.pdf$/i.test(filename)) {
      pdfs.push({ name: label || filename, url })
    } else {
      files.push({ name: label || filename, url })
    }
    return ''
  })

  // Clean up leftover whitespace
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim()

  return { images, videos, pdfs, files, cleanText }
}

import type { AppSettings } from '@/types'

/** Settings keys that can be quick-fixed from error output */
const TIMEOUT_SETTINGS: Array<{ pattern: RegExp; settingKey: keyof AppSettings; label: string; increment: number }> = [
  { pattern: /Claude Code CLI timed out/i, settingKey: 'claudeCodeTimeoutSec', label: 'Claude Code Timeout', increment: 600 },
  { pattern: /Codex CLI timed out|OpenCode CLI timed out/i, settingKey: 'cliProcessTimeoutSec', label: 'CLI Process Timeout', increment: 600 },
  { pattern: /command timed out|shell.*timed out/i, settingKey: 'shellCommandTimeoutSec', label: 'Shell Timeout', increment: 60 },
]

/** Inline quick-fix button for timeout errors */
function TimeoutQuickFix({ event }: { event: ToolEvent }) {
  const [applied, setApplied] = useState(false)
  if (event.status !== 'error' || !event.output) return null

  const match = TIMEOUT_SETTINGS.find((s) => s.pattern.test(event.output || ''))
  if (!match) return null

  const handleIncrease = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const store = useAppStore.getState()
    const current = (store.appSettings[match.settingKey] as number) || 0
    const newValue = current + match.increment
    await store.updateSettings({ [match.settingKey]: newValue })
    setApplied(true)
  }

  if (applied) {
    const store = useAppStore.getState()
    const val = store.appSettings[match.settingKey] as number
    return (
      <div className="flex items-center gap-2 mt-2 text-[12px] text-emerald-400 font-500">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
        {match.label} increased to {val}s
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={handleIncrease}
      className="mt-2 flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-[12px] font-600
        bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20
        cursor-pointer transition-all"
      style={{ fontFamily: 'inherit' }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      Increase {match.label}
    </button>
  )
}

export function ToolCallBubble({ event }: { event: ToolEvent }) {
  const [expanded, setExpanded] = useState(false)
  const [imgExpanded, setImgExpanded] = useState(false)
  const isError = event.status === 'error'
  const color = isError ? '#F43F5E' : (TOOL_COLORS[event.name] || '#6366F1')
  const isRunning = event.status === 'running'

  // For browser tool, extract the action to show a more specific label
  const label = useMemo(() => {
    if (event.name === 'browser') {
      try {
        let parsed = JSON.parse(event.input)
        // Unwrap LangChain {input: "..."} wrapper — inner value is a stringified JSON
        if (parsed?.input && Object.keys(parsed).length === 1) {
          const inner = typeof parsed.input === 'string' ? JSON.parse(parsed.input) : parsed.input
          if (typeof inner === 'object' && inner !== null) parsed = inner
        }
        const action = parsed?.action || ''
        const sub = BROWSER_ACTION_LABELS[action]
        return sub ? `Browser · ${sub}` : 'Browser'
      } catch { return 'Browser' }
    }
    return TOOL_LABELS[event.name] || event.name.replace(/_/g, ' ')
  }, [event.name, event.input])

  const inputPreview = useMemo(() => getInputPreview(event.name, event.input), [event.name, event.input])
  const formattedInput = useMemo(() => formatJson(event.input), [event.input])

  const media = useMemo(() => {
    if (!event.output) return { images: [], videos: [], pdfs: [], files: [], cleanText: '' }
    return extractMedia(event.output)
  }, [event.output])

  const formattedCleanOutput = useMemo(() => {
    if (!media.cleanText) return ''
    return formatJson(media.cleanText)
  }, [media.cleanText])

  const hasMedia = media.images.length > 0 || media.videos.length > 0 || media.pdfs.length > 0 || media.files.length > 0

  // Parse delegation info for clickable agent link
  const delegationInfo = useMemo(() => {
    if (event.name !== 'delegate_to_agent') return null
    try {
      const parsed = JSON.parse(event.input)
      return { agentName: parsed.agentName || '', agentId: parsed.agentId || '', task: parsed.task || '' }
    } catch { return null }
  }, [event.name, event.input])

  const handleAgentClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (delegationInfo?.agentId) {
      const store = useAppStore.getState()
      store.setActiveView('agents')
      store.setCurrentAgent(delegationInfo.agentId)
    }
  }

  return (
    <div className="w-full text-left">
      <button
        onClick={() => isError && setExpanded(!expanded)}
        className={`w-full text-left rounded-[12px] border bg-surface/80 backdrop-blur-sm transition-all duration-200 ${isError ? 'hover:bg-surface-2 cursor-pointer' : ''}`}
        style={{ borderLeft: `3px solid ${color}`, borderColor: `${color}33` }}
      >
        <div className="flex items-center gap-2.5 px-3.5 py-2.5">
          {isRunning ? (
            <span className="w-3.5 h-3.5 shrink-0 rounded-full border-2 border-current animate-spin" style={{ color, borderTopColor: 'transparent' }} />
          ) : isError ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" className="shrink-0">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
          <span className="text-[12px] font-700 uppercase tracking-wider shrink-0" style={{ color }}>
            {label}
          </span>
          {delegationInfo ? (
            <span className="text-[12px] text-text-2 font-mono truncate flex-1">
              <span
                role="link"
                tabIndex={0}
                onClick={handleAgentClick}
                onKeyDown={(e) => e.key === 'Enter' && handleAgentClick(e as unknown as React.MouseEvent)}
                className="text-accent-bright hover:underline cursor-pointer font-600"
              >
                {delegationInfo.agentName}
              </span>
              {delegationInfo.task && <span className="text-text-3">: {delegationInfo.task.slice(0, 80)}</span>}
            </span>
          ) : (
            <span className="text-[12px] text-text-2 font-mono truncate flex-1">
              {inputPreview}
            </span>
          )}
          {hasMedia && !expanded && (
            <span className="text-[10px] text-text-3/50 font-500 shrink-0">
              {media.images.length > 0 && `${media.images.length} image${media.images.length > 1 ? 's' : ''}`}
              {media.videos.length > 0 && `${(media.images.length > 0) ? ' · ' : ''}${media.videos.length} video${media.videos.length > 1 ? 's' : ''}`}
              {media.pdfs.length > 0 && `${(media.images.length > 0 || media.videos.length > 0) ? ' · ' : ''}${media.pdfs.length} PDF${media.pdfs.length > 1 ? 's' : ''}`}
              {media.files.length > 0 && `${(media.images.length > 0 || media.videos.length > 0 || media.pdfs.length > 0) ? ' · ' : ''}${media.files.length} file${media.files.length > 1 ? 's' : ''}`}
            </span>
          )}
          {isError && (
            <svg
              width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round"
              className={`shrink-0 text-text-3/70 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          )}
        </div>

        {expanded && isError && (
          <div className="px-3.5 pb-3 space-y-2" onClick={(e) => e.stopPropagation()}>
            <div className="text-[11px] text-text-3/60 uppercase tracking-wider font-600">Input</div>
            <pre className="text-[12px] text-text-2 font-mono whitespace-pre-wrap break-all bg-bg/50 rounded-[8px] px-3 py-2 max-h-[200px] overflow-y-auto">
              {formattedInput}
            </pre>
            {event.output && (
              <>
                <div className="text-[11px] text-text-3/60 uppercase tracking-wider font-600 mt-2">Error</div>
                {formattedCleanOutput && (
                  <pre className="text-[12px] text-text-2 font-mono whitespace-pre-wrap break-all bg-bg/50 rounded-[8px] px-3 py-2 max-h-[300px] overflow-y-auto">
                    {formattedCleanOutput}
                  </pre>
                )}
                <TimeoutQuickFix event={event} />
              </>
            )}
          </div>
        )}
      </button>

      {/* Render images below the tool call bubble (always visible when present) */}
      {media.images.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {media.images.map((src, i) => (
            <div key={i} className="relative group/img">
              <img
                src={src}
                alt={`Screenshot ${i + 1}`}
                loading="lazy"
                className={`rounded-[10px] border border-white/10 cursor-pointer transition-all duration-200 hover:border-white/25 ${imgExpanded ? 'max-w-full' : 'max-w-[400px]'}`}
                onClick={(e) => { e.stopPropagation(); setImgExpanded(!imgExpanded) }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
              <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover/img:opacity-100 transition-opacity">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    useChatStore.getState().setPreviewContent({ type: 'image', url: src, title: `${label} — Screenshot` })
                  }}
                  className="bg-black/60 backdrop-blur-sm rounded-[8px] p-1.5 hover:bg-black/80 border-none cursor-pointer"
                  title="Open in side panel"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="12" y1="3" x2="12" y2="21" />
                  </svg>
                </button>
                <a
                  href={src}
                  download
                  onClick={(e) => e.stopPropagation()}
                  className="bg-black/60 backdrop-blur-sm rounded-[8px] p-1.5 hover:bg-black/80"
                  title="Download"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </a>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Render videos */}
      {media.videos.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {media.videos.map((src, i) => (
            <video key={i} src={src} controls playsInline preload="none" className="max-w-full rounded-[10px] border border-white/10" />
          ))}
        </div>
      )}

      {/* Render PDFs inline with iframe preview + download */}
      {media.pdfs.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {media.pdfs.map((file, i) => (
            <div key={i} className="rounded-[10px] border border-white/10 overflow-hidden">
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
        </div>
      )}

      {/* Render other file download links */}
      {media.files.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {media.files.map((file, i) => (
            <a
              key={i}
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
    </div>
  )
}
