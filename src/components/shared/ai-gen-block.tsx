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
        .catch((err) => console.error('AI gen info fetch failed:', err))
    }
  }, [expanded])

  return (
    <div className="mb-10">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2.5 px-4 py-3 rounded-[14px] border border-[#6366F1]/15 bg-[#6366F1]/[0.03] hover:bg-[#6366F1]/[0.06] transition-all cursor-pointer w-full text-left"
        style={{ fontFamily: 'inherit' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-accent-bright shrink-0">
          <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" fill="currentColor" />
        </svg>
        <span className="font-display text-[13px] font-600 text-accent-bright flex-1">Generate with AI</span>
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          className={`text-accent-bright/50 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-3 p-5 rounded-[18px] border border-[#6366F1]/15 bg-[#6366F1]/[0.03]"
          style={{ animation: 'fade-in 0.2s ease' }}>
          <textarea
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder={placeholder}
            rows={2}
            className="w-full px-4 py-3 rounded-[12px] border border-[#6366F1]/10 bg-[#6366F1]/[0.02] text-text text-[14px] outline-none transition-all duration-200 placeholder:text-text-3/70 focus:border-[#6366F1]/30 resize-none"
            style={{ fontFamily: 'inherit' }}
            autoFocus
          />
          <button
            onClick={onGenerate}
            disabled={generating || !aiPrompt.trim()}
            className="mt-3 px-5 py-2.5 rounded-[12px] border-none bg-[#6366F1] text-white text-[13px] font-600 cursor-pointer disabled:opacity-30 transition-all hover:brightness-110 active:scale-[0.97] shadow-[0_2px_12px_rgba(99,102,241,0.2)]"
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
