'use client'

import { useState, useMemo } from 'react'
import type { Session } from '@/types'
import { useAppStore } from '@/stores/use-app-store'
import { useChatStore } from '@/stores/use-chat-store'
import { IconButton } from '@/components/shared/icon-button'

function shortPath(p: string): string {
  return (p || '').replace(/^\/Users\/\w+/, '~')
}

const PROVIDER_LABELS: Record<string, string> = {
  'claude-cli': 'CLI',
  openai: 'OpenAI',
  ollama: 'Ollama',
  anthropic: 'Anthropic',
}

interface Props {
  session: Session
  streaming: boolean
  onStop: () => void
  onMenuToggle: () => void
  onBack?: () => void
  mobile?: boolean
}

export function ChatHeader({ session, streaming, onStop, onMenuToggle, onBack, mobile }: Props) {
  const ttsEnabled = useChatStore((s) => s.ttsEnabled)
  const toggleTts = useChatStore((s) => s.toggleTts)
  const debugOpen = useChatStore((s) => s.debugOpen)
  const setDebugOpen = useChatStore((s) => s.setDebugOpen)
  const agents = useAppStore((s) => s.agents)
  const tasks = useAppStore((s) => s.tasks)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const providerLabel = PROVIDER_LABELS[session.provider] || session.provider
  const agent = session.agentId ? agents[session.agentId] : null
  const modelName = session.model || agent?.model || ''
  const [copied, setCopied] = useState(false)

  // Find linked task for this session
  const linkedTask = useMemo(() => {
    return Object.values(tasks).find((t) => t.sessionId === session.id)
  }, [tasks, session.id])

  const isCliSession = session.provider === 'claude-cli'
  const cliSessionId = isCliSession ? session.claudeSessionId : null

  const handleCopySessionId = () => {
    if (!cliSessionId) return
    navigator.clipboard.writeText(`claude --resume ${cliSessionId}`)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <header className="flex flex-col border-b border-white/[0.04] bg-bg/80 backdrop-blur-md shrink-0"
      style={mobile ? { paddingTop: 'max(12px, env(safe-area-inset-top))' } : undefined}>
      <div className="flex items-center gap-3 px-5 py-3 min-h-[56px]">
        {onBack && (
          <IconButton onClick={onBack}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </IconButton>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="font-display text-[16px] font-600 block truncate tracking-[-0.02em]">{session.name}</span>
            {session.provider && session.provider !== 'claude-cli' && (
              <span className="shrink-0 px-2.5 py-0.5 rounded-[7px] bg-accent-soft text-accent-bright text-[10px] font-700 uppercase tracking-wider">
                {providerLabel}
              </span>
            )}
            {agent?.isOrchestrator && (
              <span className="shrink-0 px-2.5 py-0.5 rounded-[7px] bg-[#F59E0B]/10 text-[#F59E0B] text-[10px] font-700 uppercase tracking-wider">
                Orchestrator
              </span>
            )}
            {session.tools?.length ? (
              <span className="shrink-0 px-2.5 py-0.5 rounded-[7px] bg-emerald-500/10 text-emerald-400 text-[10px] font-700 uppercase tracking-wider">
                Tools
              </span>
            ) : null}
            {streaming && (
              <span className="shrink-0 w-2 h-2 rounded-full bg-accent-bright" style={{ animation: 'pulse 1.5s ease infinite' }} />
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[11px] text-text-3/60 font-mono block truncate">{shortPath(session.cwd)}</span>
            {modelName && (
              <>
                <span className="text-[11px] text-text-3/30">·</span>
                <span className="text-[11px] text-text-3/50 font-mono truncate shrink-0">{modelName}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex gap-1.5">
          {streaming && (
            <IconButton onClick={onStop} variant="danger">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </IconButton>
          )}
          <IconButton onClick={() => setDebugOpen(!debugOpen)} active={debugOpen}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 20V10" />
              <path d="M18 20V4" />
              <path d="M6 20v-4" />
            </svg>
          </IconButton>
          <IconButton onClick={toggleTts} active={ttsEnabled}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
          </IconButton>
          <IconButton onClick={(e) => { e.stopPropagation(); onMenuToggle() }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <circle cx="12" cy="6" r="1" />
              <circle cx="12" cy="12" r="1" />
              <circle cx="12" cy="18" r="1" />
            </svg>
          </IconButton>
        </div>
      </div>

      {/* Sub-bar: task link + CLI session ID */}
      {(linkedTask || cliSessionId) && (
        <div className="flex items-center gap-3 px-5 pb-2.5 -mt-1">
          {linkedTask && (
            <button
              onClick={() => setActiveView('tasks')}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-[#F59E0B]/10 hover:bg-[#F59E0B]/15 transition-colors cursor-pointer"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" strokeWidth="2.5" strokeLinecap="round">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
              <span className="text-[11px] font-600 text-[#F59E0B] truncate max-w-[200px]">
                Task: {linkedTask.title}
              </span>
            </button>
          )}
          {cliSessionId && (
            <button
              onClick={handleCopySessionId}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] bg-white/[0.04] hover:bg-white/[0.07] transition-colors cursor-pointer group"
              title="Copy resume command to clipboard"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/50">
                <path d="M4 17l6 0l0 -6" />
                <path d="M20 7l-6 0l0 6" />
                <path d="M4 17l10 -10" />
              </svg>
              <span className="text-[11px] font-mono text-text-3/50 group-hover:text-text-3/70 truncate max-w-[180px]">
                {copied ? 'Copied!' : cliSessionId}
              </span>
              {!copied && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-text-3/30 shrink-0">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          )}
        </div>
      )}
    </header>
  )
}
