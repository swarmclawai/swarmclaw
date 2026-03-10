'use client'

import { useState, useRef, useCallback, useEffect, useMemo, type KeyboardEvent } from 'react'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { FilePreview } from '@/components/shared/file-preview'
import { useChatroomStore } from '@/stores/use-chatroom-store'
import { uploadImage } from '@/lib/upload'
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/app/safe-storage'
import type { Agent } from '@/types'

interface Props {
  agents: Agent[]
  onSend: (text: string) => void
  disabled?: boolean
}

export function ChatroomInput({ agents, onSend, disabled }: Props) {
  const [text, setText] = useState('')
  const [showMentions, setShowMentions] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const chatroomId = useChatroomStore((s) => s.currentChatroomId)
  const inputRef = useRef<HTMLTextAreaElement>(null)
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

  const resizeTextarea = useCallback(() => {
    const node = inputRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`
  }, [])

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
      setSelectedIndex(0)
    } else {
      setShowMentions(false)
      setMentionFilter('')
      setSelectedIndex(0)
    }
  }, [resizeTextarea])

  const insertMention = useCallback((name: string) => {
    const cursorPos = inputRef.current?.selectionStart || text.length
    const beforeCursor = text.slice(0, cursorPos)
    const afterCursor = text.slice(cursorPos)
    const mentionMatch = beforeCursor.match(/@(\S*)$/)
    if (mentionMatch) {
      const newBefore = beforeCursor.slice(0, mentionMatch.index) + `@${name.replace(/\s+/g, '')} `
      setText(newBefore + afterCursor)
    }
    setShowMentions(false)
    inputRef.current?.focus()
  }, [text])

  const filteredAgents = agents.filter((a) =>
    a.name.toLowerCase().replace(/\s+/g, '').includes(mentionFilter)
  )

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
        <span key={match.index} className="bg-accent-soft/50 text-accent-bright rounded px-0.5">
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
  const visibleQueuedMessages = queuedMessages.filter((item) => item.chatroomId === chatroomId)

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
        setSelectedIndex((i) => (i + 1) % mentionItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const selected = mentionItems[selectedIndex]
        if (selected) insertMention(selected)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
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
      {/* Mention dropdown */}
      {mentionDropdownVisible && (
        <div className="absolute bottom-full left-4 right-4 mb-1 bg-raised border border-white/[0.1] rounded-[8px] shadow-xl max-h-[200px] overflow-y-auto z-50">
          <button
            onClick={() => insertMention('all')}
            className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-all cursor-pointer ${
              selectedIndex === 0 ? 'bg-white/[0.08]' : 'hover:bg-white/[0.06]'
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
                  selectedIndex === i + 1 ? 'bg-white/[0.08]' : 'hover:bg-white/[0.06]'
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
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="label-mono text-amber-400/70">Queued</span>
          {visibleQueuedMessages.map((item) => (
            <span key={item.id} className="inline-flex items-center gap-1.5 rounded-[8px] border border-amber-500/15 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300">
              <span className="truncate max-w-[180px]">
                {item.text.trim() || `Attachment${item.pendingFiles.length > 1 ? 's' : ''}`}
              </span>
              {item.pendingFiles.length > 0 && (
                <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px]">
                  +{item.pendingFiles.length} file{item.pendingFiles.length === 1 ? '' : 's'}
                </span>
              )}
              <button
                type="button"
                onClick={() => removeQueuedMessage(item.id)}
                className="border-none bg-transparent p-0 text-amber-300/70 hover:text-amber-200 cursor-pointer"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}

      {visibleQueuedMessages.length === 0 && !disabled && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-[10px] border border-white/[0.06] bg-white/[0.03] px-3 py-2">
          <span className="text-[11px] text-text-3">
            {streaming
              ? 'Current round is still running. Press send to queue the next message.'
              : agents.length > 0
                ? 'Use @AgentName or @all to direct the next reply.'
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

      {/* File previews */}
      {pendingFiles.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {pendingFiles.map((f, i) => (
            <FilePreview key={i} file={f} onRemove={() => removePendingFile(i)} />
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* Attach file button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className="shrink-0 w-9 h-9 rounded-[8px] flex items-center justify-center hover:bg-white/[0.08] transition-all cursor-pointer disabled:opacity-30"
          title="Attach file"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-3">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>

        {/* Image button */}
        <button
          onClick={() => imageInputRef.current?.click()}
          disabled={disabled}
          className="shrink-0 w-9 h-9 rounded-[8px] flex items-center justify-center hover:bg-white/[0.08] transition-all cursor-pointer disabled:opacity-30"
          title="Attach image"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-3">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </button>

        <div className="flex-1 relative rounded-[10px] bg-white/[0.06] border border-white/[0.08] focus-within:border-accent-bright/40">
          {/* Highlight mirror — renders @mentions with accent background behind the transparent textarea */}
          <div
            aria-hidden
            className="absolute inset-0 px-3 py-2 text-[13px] leading-[1.5] break-words whitespace-pre-wrap pointer-events-none overflow-hidden"
            style={{ minHeight: '44px', color: 'transparent' }}
          >
            {highlightedSegments}
          </div>
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Type a message... Use @ to mention agents"
            disabled={disabled}
            rows={1}
            className="relative w-full resize-none rounded-[10px] border-none bg-transparent px-3 py-2.5 text-[13px] text-text placeholder:text-text-3 focus:outline-none max-h-[160px] disabled:opacity-50"
            style={{ minHeight: '44px' }}
          />
        </div>
        <button
          onClick={handleSendCurrent}
          disabled={(!text.trim() && !pendingFiles.length) || disabled}
          className={`shrink-0 w-10 h-10 rounded-[10px] flex items-center justify-center transition-all disabled:opacity-30 cursor-pointer ${
            streaming ? 'bg-amber-500/20 hover:bg-amber-500/30' : 'bg-accent-bright hover:bg-accent-bright/90'
          }`}
          title="Send or queue message"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>

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
