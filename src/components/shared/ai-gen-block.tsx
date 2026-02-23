'use client'

import { useState, useEffect } from 'react'
import { api } from '@/lib/api-client'

interface Props {
  aiPrompt: string
  setAiPrompt: (v: string) => void
  generating: boolean
  generated: boolean
  genError: string
  onGenerate: () => void
  appSettings?: Record<string, any>
  placeholder: string
}

export function AiGenBlock({ aiPrompt, setAiPrompt, generating, generated, genError, onGenerate, placeholder }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [genInfo, setGenInfo] = useState<{ provider: string; model: string } | null>(null)

  useEffect(() => {
    if (expanded && !genInfo) {
      api<{ provider: string; model: string }>('GET', '/generate/info')
        .then(setGenInfo)
        .catch(() => { })
    }
  }, [expanded])

  return (
    <div className="mb-10">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2.5 px-4 py-3 rounded-[14px] border border-primary/15 bg-primary/[0.03] hover:bg-primary/[0.06] transition-all cursor-pointer w-full text-left"
        style={{ fontFamily: 'inherit' }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
          <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3 1.07.56 2 1.56 2 3a2.5 2.5 0 0 1-2.5 2.5z" />
          <path d="M12 2c0 2.22-1 3.5-2 5.5 2.5 1 5.5 5 5.5 9.5a5.5 5.5 0 1 1-11 0c0-1.55.64-2.31 1.54-3.5a14.95 14.95 0 0 1 1.05-3c-.15.14-.35.15-.45.15-1.5 0-2.39-1.39-2.39-2.65 0-2.12 1.56-4.49 1.86-4.99L12 2z" />
        </svg>
        <span className="font-display text-[13px] font-600 text-primary flex-1">Generate with AI</span>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          className="text-primary/50 transition-transform duration-200"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-3 p-5 rounded-[18px] border border-primary/15 bg-primary/[0.03]"
          style={{ animation: 'fade-in 0.2s ease' }}>
          <textarea
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder={placeholder}
            rows={2}
            className="w-full px-4 py-3 rounded-[12px] border border-primary/10 bg-primary/[0.02] text-text text-[14px] outline-none transition-all duration-200 placeholder:text-text-3/40 focus:border-primary/30 resize-none"
            style={{ fontFamily: 'inherit' }}
            autoFocus
          />
          <button
            onClick={onGenerate}
            disabled={generating || !aiPrompt.trim()}
            className="mt-3 px-5 py-2.5 rounded-[12px] border-none bg-primary text-primary-foreground text-[13px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110 active:scale-[0.97] shadow-[0_2px_12px_rgba(var(--primary-rgb),0.2)]"
            style={{ fontFamily: 'inherit' }}
          >
            {generating ? 'Generating...' : generated ? 'Regenerate' : 'Generate'}
          </button>
          {generated && <span className="ml-3 text-[12px] text-emerald-400/70">Fields populated — edit below</span>}
          {genError && <p className="mt-2 text-[12px] text-red-400/80">{genError}</p>}
          <p className="mt-3 text-[11px] text-text-3/50">
            Using {genInfo ? `${genInfo.model} via ${genInfo.provider}` : 'auto-detected provider'}
          </p>
        </div>
      )}
    </div>
  )
}
