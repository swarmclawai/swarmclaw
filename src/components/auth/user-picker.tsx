'use client'

import { useId, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/stores/use-app-store'
import { AgentAvatar } from '@/components/agents/agent-avatar'
import { api } from '@/lib/app/api-client'

export function UserPicker() {
  const router = useRouter()
  const setUser = useAppStore((s) => s.setUser)
  const loadSettings = useAppStore((s) => s.loadSettings)
  const [name, setName] = useState('')
  const defaultAvatarSeed = useId().replace(/:/g, '')
  const [avatarSeed, setAvatarSeed] = useState(defaultAvatarSeed)
  const [seedOpen, setSeedOpen] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const userName = trimmed.toLowerCase()
    try {
      await api('PUT', '/settings', { userName, userAvatarSeed: avatarSeed.trim() || undefined })
    } catch { /* still set locally */ }
    setUser(userName)
    loadSettings()
    router.replace('/home')
  }

  const randomizeSeed = useCallback(() => {
    setAvatarSeed(Math.random().toString(36).slice(2, 10))
  }, [])

  const hasName = name.trim().length > 0

  return (
    <div className="h-full flex flex-col items-center justify-center px-8 bg-bg relative overflow-hidden">
      {/* Layered atmospheric gradients */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute top-[25%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[700px] h-[500px]"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.07) 0%, transparent 65%)',
            animation: 'glow-pulse 6s ease-in-out infinite',
          }}
        />
        <div
          className="absolute top-[60%] left-[35%] w-[400px] h-[400px]"
          style={{
            background: 'radial-gradient(circle, rgba(236,72,153,0.035) 0%, transparent 60%)',
            animation: 'glow-pulse 8s ease-in-out infinite 2s',
          }}
        />
        <div
          className="absolute top-[20%] right-[20%] w-[250px] h-[250px]"
          style={{
            background: 'radial-gradient(circle, rgba(52,211,153,0.025) 0%, transparent 70%)',
            animation: 'glow-pulse 10s ease-in-out infinite 4s',
          }}
        />
      </div>

      <div className="relative max-w-[460px] w-full">
        {/* Avatar as hero element */}
        <div className="flex justify-center mb-8" style={{ animation: 'spring-in 0.6s var(--ease-spring)' }}>
          <div className="relative group">
            {/* Glow ring behind avatar */}
            <div
              className="absolute inset-[-12px] rounded-full transition-all duration-700"
              style={{
                background: hasName
                  ? 'conic-gradient(from 0deg, rgba(99,102,241,0.15), rgba(236,72,153,0.1), rgba(52,211,153,0.1), rgba(99,102,241,0.15))'
                  : 'conic-gradient(from 0deg, rgba(99,102,241,0.06), transparent, rgba(99,102,241,0.06))',
                animation: 'sparkle-spin 8s linear infinite',
                filter: 'blur(8px)',
              }}
            />
            <div
              className="absolute inset-[-4px] rounded-full transition-all duration-500"
              style={{
                border: '1px solid',
                borderColor: hasName ? 'rgba(99,102,241,0.2)' : 'rgba(255,255,255,0.06)',
              }}
            />
            <div className="relative">
              <AgentAvatar seed={avatarSeed || null} name={name || '?'} size={96} />
            </div>

            {/* Dice button — overlaid on avatar corner */}
            <button
              type="button"
              onClick={randomizeSeed}
              className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-surface border border-white/[0.08]
                flex items-center justify-center cursor-pointer
                hover:bg-white/[0.08] hover:border-accent-bright/30 active:scale-90
                transition-all duration-200 z-10"
              title="Randomize avatar"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-3">
                <rect x="2" y="2" width="20" height="20" rx="3" />
                <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
                <circle cx="16" cy="8" r="1.5" fill="currentColor" stroke="none" />
                <circle cx="8" cy="16" r="1.5" fill="currentColor" stroke="none" />
                <circle cx="16" cy="16" r="1.5" fill="currentColor" stroke="none" />
              </svg>
            </button>
          </div>
        </div>

        {/* Text + form */}
        <div className="text-center">
          <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.1s both' }}>
            <h1 className="font-display text-[38px] font-800 leading-[1.05] tracking-[-0.04em] mb-2">
              Welcome
            </h1>
            <p className="text-[14px] text-text-2 mb-8">
              What should we call you?
            </p>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col items-center gap-5">
            <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.2s both', width: '100%', display: 'flex', justifyContent: 'center' }}>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                autoFocus
                className="w-full max-w-[300px] px-6 py-4 rounded-[16px] border border-white/[0.08] bg-surface
                  text-text text-[18px] text-center font-display font-600 outline-none
                  transition-all duration-200 placeholder:text-text-3/70
                  focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                style={{ fontFamily: 'inherit' }}
              />
            </div>

            {/* Collapsible avatar seed — tucked away for power users */}
            <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.3s both' }}>
              {!seedOpen ? (
                <button
                  type="button"
                  onClick={() => setSeedOpen(true)}
                  className="bg-transparent border-none text-[12px] text-text-3 cursor-pointer hover:text-text-2 transition-colors"
                >
                  Customize avatar seed
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={avatarSeed}
                    onChange={(e) => setAvatarSeed(e.target.value)}
                    placeholder="Avatar seed"
                    className="w-[160px] px-3 py-2 rounded-[10px] border border-white/[0.08] bg-surface
                      text-text text-[13px] text-center outline-none transition-all
                      focus:border-accent-bright/30"
                  />
                  <button
                    type="button"
                    onClick={randomizeSeed}
                    className="px-3 py-2 rounded-[10px] border border-white/[0.08] bg-transparent text-text-3 text-[12px] font-600
                      cursor-pointer transition-all hover:bg-white/[0.04] shrink-0"
                  >
                    Randomize
                  </button>
                </div>
              )}
            </div>

            <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.4s both' }}>
              <button
                type="submit"
                disabled={!hasName}
                className="px-12 py-4 rounded-[16px] border-none bg-accent-bright text-white text-[16px] font-display font-600
                  cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                  shadow-[0_6px_28px_rgba(99,102,241,0.3)] disabled:opacity-30"
                style={{ fontFamily: 'inherit' }}
              >
                Get Started
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
