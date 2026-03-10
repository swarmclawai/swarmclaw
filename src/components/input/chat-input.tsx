'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/stores/use-chat-store'
import { useAppStore } from '@/stores/use-app-store'
import { selectActiveSessionId } from '@/stores/slices/session-slice'
import { uploadImage } from '@/lib/upload'
import { useAutoResize } from '@/hooks/use-auto-resize'
import { useSpeechRecognition } from '@/hooks/use-speech-recognition'
import { FilePreview } from '@/components/shared/file-preview'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { toast } from 'sonner'
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/app/safe-storage'
import { errorMessage } from '@/lib/shared-utils'

interface Props {
  streaming: boolean
  onSend: (text: string) => void
  onStop: () => void
  pluginChatActions?: Array<{ id: string; label: string; action: string; value: string; tooltip?: string }>
}

// FilePreview is now imported from @/components/shared/file-preview

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

export function ChatInput({ streaming, onSend, onStop, pluginChatActions = [] }: Props) {
  const [value, setValue] = useState('')
  const [extrasOpen, setExtrasOpen] = useState(false)
  const { ref: textareaRef, resize } = useAutoResize()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const extrasRef = useRef<HTMLDivElement>(null)
  const pendingFiles = useChatStore((s) => s.pendingFiles)
  const addPendingFile = useChatStore((s) => s.addPendingFile)
  const removePendingFile = useChatStore((s) => s.removePendingFile)
  const speechRecognitionLang = useAppStore((s) => s.appSettings.speechRecognitionLang)
  const sessionId = useAppStore(selectActiveSessionId)

  const queuedMessages = useChatStore((s) => s.queuedMessages)
  const addQueuedMessage = useChatStore((s) => s.addQueuedMessage)
  const removeQueuedMessage = useChatStore((s) => s.removeQueuedMessage)

  useEffect(() => {
    if (!extrasOpen) return
    const handler = (e: MouseEvent) => {
      if (extrasRef.current && !extrasRef.current.contains(e.target as Node)) {
        setExtrasOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [extrasOpen])

  // Draft persistence: restore on session change
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!sessionId) return
    const draft = safeStorageGet(`sc_draft_${sessionId}`)
    setValue(draft || '')
  }, [sessionId])

  // Debounced save to localStorage
  useEffect(() => {
    if (!sessionId) return
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = setTimeout(() => {
      if (value) safeStorageSet(`sc_draft_${sessionId}`, value)
      else safeStorageRemove(`sc_draft_${sessionId}`)
    }, 300)
    return () => { if (draftTimerRef.current) clearTimeout(draftTimerRef.current) }
  }, [value, sessionId])

  const handleSend = useCallback(() => {
    const text = value.trim()
    if (!text && !pendingFiles.length) return
    // If streaming, queue the message instead of blocking
    if (streaming) {
      if (pendingFiles.length > 0) {
        toast.error('Wait for the current reply to finish before sending files.')
        return
      }
      if (text) {
        addQueuedMessage(text)
        setValue('')
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
      }
      return
    }
    onSend(text || 'See attached file(s).')
    setValue('')
    if (sessionId) safeStorageRemove(`sc_draft_${sessionId}`)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, streaming, onSend, pendingFiles.length, sessionId])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const handleVoice = useCallback((text: string) => {
    onSend(text)
  }, [onSend])

  const { recording, toggle: toggleRecording, supported: micSupported, error: micError } = useSpeechRecognition(
    handleVoice,
    { lang: speechRecognitionLang || undefined },
  )

  const uploadAndAdd = useCallback(async (file: File) => {
    if (file.size > MAX_FILE_SIZE) {
      toast.error(`File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max 10 MB)`)
      return
    }
    try {
      const result = await uploadImage(file)
      addPendingFile({ file, path: result.path, url: result.url })
    } catch (err: unknown) {
      console.error('File upload failed:', errorMessage(err))
    }
  }, [addPendingFile])

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

  const hasContent = value.trim().length > 0 || pendingFiles.length > 0

  return (
    <div className="shrink-0 px-4 md:px-12 lg:px-16 pb-4 pt-2 fixed bottom-0 left-0 right-0 z-20 bg-bg/95 backdrop-blur-md md:relative md:z-auto md:bg-transparent md:backdrop-blur-none"
      style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
      <div className="relative" ref={extrasRef}>
        {streaming && (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-amber-500/15 bg-amber-500/[0.06] px-3.5 py-2">
            <div className="min-w-0">
              <div className="text-[12px] font-600 text-amber-300">Reply in progress</div>
              <div className="text-[11px] text-amber-200/70">
                New text sends queue automatically. File uploads wait for the current reply to finish.
              </div>
            </div>
            <button
              onClick={onStop}
              aria-label="Stop response"
              data-testid="chat-stop"
              className="px-4 py-2 rounded-pill border border-danger/20 bg-danger/[0.06]
                text-danger text-[12px] font-600 cursor-pointer transition-all duration-200
                active:scale-95 hover:bg-danger/[0.1] hover:border-danger/30 shrink-0"
              style={{ fontFamily: 'inherit' }}
            >
              Stop
            </button>
          </div>
        )}

        {queuedMessages.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            <span className="label-mono text-amber-400/70">Sending next</span>
            {queuedMessages.map((msg, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-amber-500/10 border border-amber-500/15 text-[12px] text-amber-300 font-mono max-w-[200px]">
                <span className="truncate">{msg}</span>
                <button
                  type="button"
                  onClick={() => removeQueuedMessage(i)}
                  className="shrink-0 text-amber-400/60 hover:text-amber-300 border-none bg-transparent cursor-pointer p-0"
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

        <div className="glass rounded-[20px] overflow-hidden
          shadow-[0_4px_32px_rgba(0,0,0,0.3)] focus-within:border-border-focus focus-within:shadow-[0_4px_32px_rgba(99,102,241,0.08)] transition-all duration-300">

          {pendingFiles.length > 0 && (
            <div className="flex items-center gap-2 px-5 pt-4 flex-wrap">
              {pendingFiles.map((f, i) => (
                <FilePreview key={`${f.path}-${i}`} file={f} onRemove={() => removePendingFile(i)} />
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => { setValue(e.target.value); resize() }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Ask me anything..."
            aria-label="Message input"
            data-testid="chat-input"
            rows={1}
            className="w-full px-5 pt-4 pb-2 bg-transparent text-text text-[15px] outline-none resize-none
              max-h-[140px] leading-[1.55] placeholder:text-text-3/70 border-none"
            style={{ fontFamily: 'inherit' }}
          />

          <div className="flex items-center gap-1 px-4 pb-3.5">
            <button
              type="button"
              onClick={() => setExtrasOpen((open) => !open)}
              aria-label="Add attachment"
              data-testid="chat-add"
              className="flex items-center gap-1.5 px-3 py-2 rounded-[10px] border-none bg-transparent
                text-text-3 text-[13px] cursor-pointer hover:text-text-2 hover:bg-white/[0.05] transition-all duration-200"
              style={{ fontFamily: 'inherit' }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
              <span className="hidden sm:inline">Add</span>
            </button>

            <div className="flex-1" />

            <span className="text-[11px] text-text-3/60 tabular-nums mr-2 font-mono">
              {value.length > 0 && value.length}
            </span>

            <button
              onClick={handleSend}
              disabled={!hasContent}
              aria-label={streaming ? 'Queue message' : 'Send message'}
              data-testid="chat-send"
              className={`w-9 h-9 rounded-[11px] border-none flex items-center justify-center
                shrink-0 cursor-pointer transition-all duration-250
                ${hasContent
                  ? streaming
                    ? 'bg-amber-500/20 text-amber-400 active:scale-90 border border-amber-500/30'
                    : 'bg-accent-bright text-white active:scale-90 shadow-[0_4px_16px_rgba(99,102,241,0.3)]'
                  : 'bg-white/[0.04] text-text-3 pointer-events-none'}`}
              title={streaming ? 'Queue message' : 'Send message'}
            >
              {streaming && hasContent ? (
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
        </div>

        {extrasOpen && (
          <div className="absolute left-0 bottom-[72px] w-[280px] max-w-[calc(100vw-2rem)] rounded-[16px] border border-white/[0.08] bg-raised/95 p-2 shadow-[0_18px_64px_rgba(0,0,0,0.55)] backdrop-blur-xl">
            <button
              type="button"
              onClick={() => {
                setExtrasOpen(false)
                fileInputRef.current?.click()
              }}
              className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[13px] text-text-2 hover:bg-white/[0.05] cursor-pointer transition-colors"
              style={{ fontFamily: 'inherit' }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
              Attach files
            </button>
            <button
              type="button"
              onClick={() => {
                setExtrasOpen(false)
                imageInputRef.current?.click()
              }}
              className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[13px] text-text-2 hover:bg-white/[0.05] cursor-pointer transition-colors"
              style={{ fontFamily: 'inherit' }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
              Add image
            </button>
            {micSupported && (
              <button
                type="button"
                onClick={() => {
                  setExtrasOpen(false)
                  toggleRecording()
                }}
                className={`flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[13px] cursor-pointer transition-colors ${
                  recording ? 'text-danger bg-danger/[0.06]' : 'text-text-2 hover:bg-white/[0.05]'
                }`}
                style={recording ? { animation: 'mic-pulse 1.5s ease-out infinite', fontFamily: 'inherit' } : { fontFamily: 'inherit' }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <rect x="9" y="2" width="6" height="11" rx="3" />
                  <path d="M5 10a7 7 0 0 0 14 0" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
                {recording ? 'Stop microphone' : 'Use microphone'}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setExtrasOpen(false)
                void useChatStore.getState().clearContext()
              }}
              disabled={streaming}
              className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[13px] text-text-2 hover:bg-white/[0.05] cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ fontFamily: 'inherit' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="2" y1="12" x2="22" y2="12" />
                <polyline points="8 8 4 12 8 16" />
                <polyline points="16 8 20 12 16 16" />
              </svg>
              New context window
            </button>
            {pluginChatActions.length > 0 && (
              <>
                <div className="mx-2 my-1 h-px bg-white/[0.06]" />
                <div className="px-3 pb-1 pt-1 text-[10px] font-700 uppercase tracking-[0.08em] text-text-3/50">
                  Quick actions
                </div>
                {pluginChatActions.map((action) => (
                  <Tooltip key={action.id}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => {
                          setExtrasOpen(false)
                          if (action.action === 'message') onSend(action.value)
                          else if (action.action === 'link') window.open(action.value, '_blank')
                        }}
                        className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[13px] text-emerald-300 hover:bg-emerald-500/[0.08] cursor-pointer transition-colors"
                        style={{ fontFamily: 'inherit' }}
                      >
                        {action.label}
                      </button>
                    </TooltipTrigger>
                    {action.tooltip && <TooltipContent>{action.tooltip}</TooltipContent>}
                  </Tooltip>
                ))}
              </>
            )}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.txt,.md,.csv,.json,.xml,.html,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.yml,.yaml,.toml,.env,.log,.sh,.sql,.css,.scss"
          onChange={handleFileChange}
          className="hidden"
        />
        <input
          ref={imageInputRef}
          type="file"
          multiple
          accept="image/*"
          onChange={handleFileChange}
          className="hidden"
        />

        <p className="text-[10px] text-text-3/40 mt-1.5 px-1 select-none">
          Shift+Enter for newline
        </p>

        {micError && (
          <p className="text-[11px] text-danger/80 mt-2 px-1">{micError}</p>
        )}
      </div>
    </div>
  )
}
