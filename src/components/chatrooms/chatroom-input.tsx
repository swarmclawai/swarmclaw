'use client'

import { useState, useRef, useCallback, useEffect, useMemo, type KeyboardEvent } from 'react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { ComposerShell } from '@/components/input/composer-shell'
import type { StructuredSessionLaunchContext } from '@/components/protocols/structured-session-launcher'
import { FilePreview } from '@/components/shared/file-preview'
import { useChatroomStore } from '@/stores/use-chatroom-store'
import { uploadImage } from '@/lib/upload'
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/app/safe-storage'
import {
  BREAKOUT_COMMAND,
  buildBreakoutLaunchContext,
  completeBreakoutCommand,
  parseBreakoutCommand,
} from './breakout-command'
import type { Agent } from '@/types'

interface Props {
  agents: Agent[]
  onSend: (text: string) => void
  disabled?: boolean
  onBreakoutRequest?: (context: StructuredSessionLaunchContext) => void
}

export function ChatroomInput({ agents, onSend, disabled, onBreakoutRequest }: Props) {
  const [text, setText] = useState('')
  const [showMentions, setShowMentions] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0)
  const chatroomId = useChatroomStore((s) => s.currentChatroomId)
  const chatrooms = useChatroomStore((s) => s.chatrooms)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

  const pendingFiles = useChatroomStore((s) => s.pendingFiles)
  const addPendingFile = useChatroomStore((s) => s.addPendingFile)
  const removePendingFile = useChatroomStore((s) => s.removePendingFile)
  const replyingTo = useChatroomStore((s) => s.replyingTo)
  const setReplyingTo = useChatroomStore((s) => s.setReplyingTo)
  const streaming = useChatroomStore((s) => s.streaming)
  const queuedMessages = useChatroomStore((s) => s.queuedMessages)
  const removeQueuedMessage = useChatroomStore((s) => s.removeQueuedMessage)
  const clearQueuedMessages = useChatroomStore((s) => s.clearQueuedMessages)
  const currentChatroom = chatroomId ? chatrooms[chatroomId] : null

  const syncMirrorScroll = useCallback(() => {
    const input = inputRef.current
    const mirror = mirrorRef.current
    if (!input || !mirror) return
    mirror.scrollTop = input.scrollTop
    mirror.scrollLeft = input.scrollLeft
  }, [])

  const resizeTextarea = useCallback(() => {
    const node = inputRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`
    syncMirrorScroll()
  }, [syncMirrorScroll])

  // Draft persistence: restore on chatroom change
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!chatroomId) return
    const draft = safeStorageGet(`sc_draft_cr_${chatroomId}`)
    setText(draft || '')
  }, [chatroomId])

  useEffect(() => {
    resizeTextarea()
  }, [resizeTextarea, text, chatroomId])

  // Debounced save to localStorage
  useEffect(() => {
    if (!chatroomId) return
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = setTimeout(() => {
      if (text) safeStorageSet(`sc_draft_cr_${chatroomId}`, text)
      else safeStorageRemove(`sc_draft_cr_${chatroomId}`)
    }, 300)
    return () => { if (draftTimerRef.current) clearTimeout(draftTimerRef.current) }
  }, [text, chatroomId])

  const uploadAndAdd = useCallback(async (file: File) => {
    try {
      const result = await uploadImage(file)
      addPendingFile({ file, path: result.path, url: result.url })
    } catch {
      // ignore upload errors
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) await uploadAndAdd(file)
        return
      }
    }
  }, [uploadAndAdd])

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files?.length) return
    for (const file of Array.from(files)) {
      await uploadAndAdd(file)
    }
    e.target.value = ''
  }, [uploadAndAdd])

  const handleChange = useCallback((value: string) => {
    setText(value)
    resizeTextarea()
    const cursorPos = inputRef.current?.selectionStart || value.length
    const beforeCursor = value.slice(0, cursorPos)
    const mentionMatch = beforeCursor.match(/@(\S*)$/)
    if (mentionMatch) {
      setShowMentions(true)
      setMentionFilter(mentionMatch[1].toLowerCase())
      setSelectedMentionIndex(0)
    } else {
      setShowMentions(false)
      setMentionFilter('')
      setSelectedMentionIndex(0)
    }
    setSelectedSlashIndex(0)
  }, [resizeTextarea])

  const insertMention = useCallback((name: string) => {
    const cursorPos = inputRef.current?.selectionStart || text.length
    const beforeCursor = text.slice(0, cursorPos)
    const afterCursor = text.slice(cursorPos)
    const mentionMatch = beforeCursor.match(/@(\S*)$/)
    if (mentionMatch) {
      const normalizedName = name.replace(/\s+/g, '')
      const needsSpace = afterCursor.length === 0 || !/^\s/.test(afterCursor)
      const newBefore = beforeCursor.slice(0, mentionMatch.index) + `@${normalizedName}${needsSpace ? ' ' : ''}`
      const nextText = newBefore + afterCursor
      const nextCursorPos = newBefore.length
      setText(nextText)
      requestAnimationFrame(() => {
        const input = inputRef.current
        if (!input) return
        input.focus()
        input.setSelectionRange(nextCursorPos, nextCursorPos)
        syncMirrorScroll()
      })
    }
    setShowMentions(false)
  }, [syncMirrorScroll, text])

  const filteredAgents = agents.filter((a) =>
    a.name.toLowerCase().replace(/\s+/g, '').includes(mentionFilter)
  )
  const breakoutCommand = useMemo(() => parseBreakoutCommand(text), [text])

  // Build highlighted segments for the mirror overlay
  const highlightedSegments = useMemo(() => {
    if (!text) return null
    const parts: React.ReactNode[] = []
    let lastIndex = 0
    const regex = /@\S+/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(text.slice(lastIndex, match.index))
      }
      parts.push(
        <span key={match.index} className="bg-accent-soft/45 text-accent-bright rounded">
          {match[0]}
        </span>
      )
      lastIndex = regex.lastIndex
    }
    if (lastIndex < text.length) {
      parts.push(text.slice(lastIndex))
    }
    return parts.length > 0 ? parts : null
  }, [text])

  const mentionDropdownVisible = showMentions
  const mentionItems = mentionDropdownVisible
    ? ['all', ...filteredAgents.map((a) => a.name)]
    : []
  const slashDropdownVisible = !mentionDropdownVisible && !disabled && breakoutCommand.kind !== 'none'
  const slashItems = slashDropdownVisible
    ? [{
        id: BREAKOUT_COMMAND,
        label: BREAKOUT_COMMAND,
        description: 'Start a focused structured session from this room',
      }]
    : []
  const visibleQueuedMessages = queuedMessages.filter((item) => item.chatroomId === chatroomId)

  const focusInputAtEnd = useCallback((value: string) => {
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      input.setSelectionRange(value.length, value.length)
      syncMirrorScroll()
    })
  }, [syncMirrorScroll])

  const handleCompleteBreakoutCommand = useCallback(() => {
    if (breakoutCommand.kind === 'command') return
    const nextText = completeBreakoutCommand(text)
    setText(nextText)
    focusInputAtEnd(nextText)
  }, [breakoutCommand.kind, focusInputAtEnd, text])

  const handleOpenBreakout = useCallback(() => {
    if (disabled || !onBreakoutRequest || breakoutCommand.kind !== 'command' || !currentChatroom) return false
    onBreakoutRequest(buildBreakoutLaunchContext(currentChatroom, breakoutCommand.topic))
    setText('')
    resizeTextarea()
    if (chatroomId) safeStorageRemove(`sc_draft_cr_${chatroomId}`)
    setShowMentions(false)
    setMentionFilter('')
    setSelectedMentionIndex(0)
    setSelectedSlashIndex(0)
    return true
  }, [
    breakoutCommand,
    chatroomId,
    currentChatroom,
    disabled,
    onBreakoutRequest,
    resizeTextarea,
  ])

  const handleSendCurrent = useCallback(() => {
    if ((!text.trim() && !pendingFiles.length) || disabled) return
    onSend(text)
    setText('')
    resizeTextarea()
    if (chatroomId) safeStorageRemove(`sc_draft_cr_${chatroomId}`)
    setShowMentions(false)
  }, [chatroomId, disabled, onSend, pendingFiles.length, resizeTextarea, text])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionDropdownVisible && mentionItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedMentionIndex((i) => (i + 1) % mentionItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const selected = mentionItems[selectedMentionIndex]
        if (selected) insertMention(selected)
        return
      }
    }

    if (slashDropdownVisible && slashItems.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedSlashIndex(0)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && breakoutCommand.kind === 'candidate') {
        e.preventDefault()
        handleCompleteBreakoutCommand()
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (handleOpenBreakout()) return
      handleSendCurrent()
    }
    if (e.key === 'Escape') {
      if (replyingTo) {
        setReplyingTo(null)
      }
      setShowMentions(false)
    }
  }

  return (
    <div className="relative px-4 py-3 border-t border-white/[0.06]">
      {slashDropdownVisible && (
        <div className="absolute bottom-full left-4 right-4 mb-1 bg-raised border border-white/[0.1] rounded-[8px] shadow-xl max-h-[200px] overflow-y-auto z-50">
          {slashItems.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (breakoutCommand.kind === 'command') {
                  handleOpenBreakout()
                  return
                }
                handleCompleteBreakoutCommand()
              }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-all cursor-pointer ${
                selectedSlashIndex === index ? 'bg-white/[0.08]' : 'hover:bg-white/[0.06]'
              }`}
            >
              <div className="flex h-6 min-w-6 items-center justify-center rounded-[8px] bg-sky-500/12 text-[10px] font-700 text-sky-200">
                /
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-600 text-text">{item.label}</div>
                <div className="text-[11px] text-text-3">{item.description}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Mention dropdown */}
      {mentionDropdownVisible && (
        <div className="absolute bottom-full left-4 right-4 mb-1 bg-raised border border-white/[0.1] rounded-[8px] shadow-xl max-h-[200px] overflow-y-auto z-50">
          <button
            onClick={() => insertMention('all')}
            className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-all cursor-pointer ${
              selectedMentionIndex === 0 ? 'bg-white/[0.08]' : 'hover:bg-white/[0.06]'
            }`}
          >
            <div className="w-5 h-5 rounded-full bg-accent-soft flex items-center justify-center text-[9px] font-700 text-accent-bright">@</div>
            <span className="text-[13px] text-text">all</span>
            <span className="text-[11px] text-text-3 ml-auto">Mention all agents</span>
          </button>
          {filteredAgents.length > 0 ? (
            filteredAgents.map((agent, i) => (
              <button
                key={agent.id}
                onClick={() => insertMention(agent.name)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-all cursor-pointer ${
                  selectedMentionIndex === i + 1 ? 'bg-white/[0.08]' : 'hover:bg-white/[0.06]'
                }`}
              >
                <AgentAvatar seed={agent.avatarSeed} avatarUrl={agent.avatarUrl} name={agent.name} size={20} />
                <span className="text-[13px] text-text">{agent.name}</span>
              </button>
            ))
          ) : (
            <div className="px-3 py-3 text-[12px] text-text-3">
              No agents match <span className="text-text">@{mentionFilter}</span>.
            </div>
          )}
        </div>
      )}

      {visibleQueuedMessages.length > 0 && (
        <div className="mb-2 overflow-hidden rounded-[14px] border border-amber-500/18 bg-[linear-gradient(180deg,rgba(245,158,11,0.08)_0%,rgba(245,158,11,0.03)_100%)] shadow-[0_10px_32px_rgba(245,158,11,0.06)]">
          <div className="flex items-start justify-between gap-3 border-b border-amber-500/10 px-3.5 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="absolute inline-flex h-2.5 w-2.5 rounded-full bg-amber-400/30 animate-ping" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-300" />
                </span>
                <span className="label-mono text-amber-300/80">Round queue</span>
                <span className="rounded-pill border border-amber-400/15 bg-amber-400/10 px-2 py-0.5 text-[10px] font-600 text-amber-200">
                  {visibleQueuedMessages.length}
                </span>
                <span className={`rounded-pill border px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] ${
                  streaming
                    ? 'border-amber-300/20 bg-amber-300/10 text-amber-100'
                    : 'border-white/[0.08] bg-white/[0.05] text-text-3'
                }`}>
                  {streaming ? 'Round running' : 'Queue ready'}
                </span>
              </div>
              <div className="mt-2 text-[12px] text-amber-100/80">
                {streaming
                  ? 'Queued prompts will send automatically when the current round finishes.'
                  : 'Queued prompts are ready and will dispatch automatically.'}
              </div>
            </div>
            {chatroomId && visibleQueuedMessages.length > 1 && (
              <button
                type="button"
                onClick={() => clearQueuedMessages(chatroomId)}
                className="shrink-0 rounded-pill border border-amber-400/15 bg-transparent px-3 py-1.5 text-[11px] font-600 text-amber-200/80 transition-all hover:border-amber-300/30 hover:bg-amber-300/[0.08] hover:text-amber-100 cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>
          <div className="max-h-[184px] space-y-1.5 overflow-y-auto px-2.5 py-2.5">
            {visibleQueuedMessages.map((item, index) => (
              <div
                key={item.id}
                className={`flex items-start gap-3 rounded-[12px] border px-3 py-2.5 ${
                  index === 0
                    ? 'border-amber-300/20 bg-amber-300/[0.07]'
                    : 'border-white/[0.05] bg-white/[0.02]'
                }`}
              >
                <div className={`mt-0.5 flex h-6 min-w-6 items-center justify-center rounded-[8px] px-2 text-[10px] font-700 ${
                  index === 0
                    ? 'bg-amber-300/15 text-amber-100'
                    : 'bg-white/[0.06] text-text-3'
                }`}>
                  {index + 1}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {index === 0 && (
                      <span className="rounded-pill border border-amber-300/15 bg-amber-300/10 px-2 py-0.5 text-[10px] font-700 uppercase tracking-[0.12em] text-amber-100">
                        Next
                      </span>
                    )}
                    {item.pendingFiles.length > 0 && (
                      <span className="rounded-pill border border-amber-400/15 bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-200">
                        +{item.pendingFiles.length} file{item.pendingFiles.length === 1 ? '' : 's'}
                      </span>
                    )}
                    {item.replyingTo && (
                      <span className="rounded-pill border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-[10px] text-text-3">
                        Reply queued
                      </span>
                    )}
                  </div>
                  <p className="mt-1 break-words text-[12px] leading-5 text-text/90 m-0">
                    {item.text.trim() || `Attachment${item.pendingFiles.length === 1 ? '' : 's'} only`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeQueuedMessage(item.id)}
                  className="shrink-0 rounded-[8px] border border-transparent bg-transparent p-1.5 text-amber-300/60 transition-all hover:border-amber-300/20 hover:bg-amber-300/[0.08] hover:text-amber-100 cursor-pointer"
                  aria-label={`Remove queued chatroom message ${index + 1}`}
                  title="Remove from queue"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {visibleQueuedMessages.length === 0 && !disabled && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-[10px] border border-white/[0.06] bg-white/[0.03] px-3 py-2">
          <span className="text-[11px] text-text-3">
            {streaming
              ? 'Current round is still running. Press send to queue the next message.'
              : agents.length > 0
                ? 'Use @AgentName or @all to direct the next reply, or /breakout to spin up a focused session.'
                : 'Start the next round here.'}
          </span>
          <span className="text-[10px] text-text-3/50">Enter sends · Shift+Enter newline</span>
        </div>
      )}

      {/* Reply preview banner */}
      {replyingTo && (
        <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-[8px] bg-white/[0.04] border border-white/[0.06]">
          <div className="w-0.5 self-stretch rounded-full bg-accent-bright/50 shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-[11px] font-600 text-accent-bright">{replyingTo.senderName}</span>
            <p className="text-[12px] text-text-3 truncate m-0">
              {replyingTo.text.length > 100 ? replyingTo.text.slice(0, 100) + '...' : replyingTo.text}
            </p>
          </div>
          <button
            onClick={() => setReplyingTo(null)}
            className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center hover:bg-white/[0.08] cursor-pointer text-text-3 hover:text-text transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      <ComposerShell
        top={pendingFiles.length > 0 ? (
          <div className="flex items-center gap-2 px-5 pt-4 flex-wrap">
            {pendingFiles.map((f, i) => (
              <FilePreview key={i} file={f} onRemove={() => removePendingFile(i)} />
            ))}
          </div>
        ) : undefined}
        footer={(
          <div className="flex items-center gap-1 px-4 pb-3.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="flex items-center gap-1.5 px-3 py-2 rounded-[10px] border-none bg-transparent text-text-3 text-[13px] cursor-pointer hover:text-text-2 hover:bg-white/[0.05] transition-all duration-200 disabled:opacity-30"
              title="Attach file"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
              <span className="hidden sm:inline">Files</span>
            </button>
            <button
              type="button"
              onClick={() => imageInputRef.current?.click()}
              disabled={disabled}
              className="flex items-center gap-1.5 px-3 py-2 rounded-[10px] border-none bg-transparent text-text-3 text-[13px] cursor-pointer hover:text-text-2 hover:bg-white/[0.05] transition-all duration-200 disabled:opacity-30"
              title="Attach image"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
              <span className="hidden sm:inline">Image</span>
            </button>

            <div className="flex-1" />

            <span className="text-[11px] text-text-3/60 tabular-nums mr-2 font-mono">
              {text.length > 0 && text.length}
            </span>

            <button
              onClick={handleSendCurrent}
              disabled={(!text.trim() && !pendingFiles.length) || disabled}
              aria-label={streaming ? 'Queue message' : 'Send message'}
              className={`w-9 h-9 rounded-[11px] border-none flex items-center justify-center shrink-0 cursor-pointer transition-all duration-250 ${
                (!text.trim() && !pendingFiles.length) || disabled
                  ? 'bg-white/[0.04] text-text-3 pointer-events-none'
                  : streaming
                    ? 'bg-amber-500/20 text-amber-400 active:scale-90 border border-amber-500/30'
                    : 'bg-accent-bright text-white active:scale-90 shadow-[0_4px_16px_rgba(99,102,241,0.3)]'
              }`}
              title={streaming ? 'Queue message' : 'Send message'}
            >
              {streaming ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              )}
            </button>
          </div>
        )}
        hint={disabled ? 'Live rooms are watch-first' : 'Shift+Enter for newline · /breakout starts a focused session'}
      >
        <div className="relative">
          {/* Highlight mirror — renders the visible text while the textarea handles input and caret. */}
          <div
            ref={mirrorRef}
            aria-hidden
            className="absolute inset-0 px-5 pt-4 pb-2 text-[15px] leading-[1.55] text-text break-words whitespace-pre-wrap pointer-events-none overflow-hidden"
            style={{ minHeight: '56px' }}
          >
            {highlightedSegments}
          </div>
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onScroll={syncMirrorScroll}
            placeholder="Ask the room anything... Use @ to mention agents or /breakout to focus the room"
            disabled={disabled}
            rows={1}
            className="relative w-full resize-none border-none bg-transparent px-5 pt-4 pb-2 text-[15px] text-transparent caret-white placeholder:text-text-3/70 focus:outline-none selection:bg-accent-bright/20 max-h-[160px] leading-[1.55] disabled:opacity-50"
            style={{ minHeight: '56px', caretColor: 'rgb(244 244 245)' }}
          />
        </div>
      </ComposerShell>

      {/* Hidden file inputs */}
      <input ref={fileInputRef} type="file" multiple
        accept="image/*,.pdf,.txt,.md,.csv,.json,.xml,.html,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.yml,.yaml,.toml,.env,.log,.sh,.sql,.css,.scss"
        onChange={handleFileChange} className="hidden" />
      <input ref={imageInputRef} type="file" multiple
        accept="image/*"
        onChange={handleFileChange} className="hidden" />
    </div>
  )
}
