'use client'

import { useState } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { api } from '@/lib/api-client'

export function UserPicker() {
  const setUser = useAppStore((s) => s.setUser)
  const [name, setName] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const userName = trimmed.toLowerCase()
    // Save server-side so it persists across devices
    try {
      await api('PUT', '/settings', { userName })
    } catch { /* still set locally */ }
    setUser(userName)
  }

  return (
    <div className="h-full flex flex-col items-center justify-center px-8 bg-bg relative overflow-hidden">
      {/* Atmospheric gradient mesh */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-[30%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px]"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.06) 0%, transparent 70%)',
            animation: 'glow-pulse 6s ease-in-out infinite',
          }} />
        <div className="absolute bottom-[20%] left-[30%] w-[300px] h-[300px]"
          style={{
            background: 'radial-gradient(circle, rgba(236,72,153,0.03) 0%, transparent 70%)',
            animation: 'glow-pulse 8s ease-in-out infinite 2s',
          }} />
      </div>

      <div className="relative max-w-[420px] w-full text-center"
        style={{ animation: 'fade-in 0.6s cubic-bezier(0.16, 1, 0.3, 1)' }}>

        {/* Sparkle icon */}
        <div className="flex justify-center mb-6">
          <div className="relative w-12 h-12">
            <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="text-accent-bright"
              style={{ animation: 'sparkle-spin 8s linear infinite' }}>
              <path d="M24 4L27.5 18.5L42 24L27.5 29.5L24 44L20.5 29.5L6 24L20.5 18.5L24 4Z"
                fill="currentColor" opacity="0.9" />
            </svg>
            <div className="absolute inset-0 blur-xl bg-accent-bright/20" />
          </div>
        </div>

        <h1 className="font-display text-[42px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
          Welcome
        </h1>
        <p className="text-[15px] text-text-2 mb-10">
          What should we call you?
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col items-center gap-5">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            autoFocus
            className="w-full max-w-[280px] px-6 py-4 rounded-[16px] border border-white/[0.08] bg-surface
              text-text text-[18px] text-center font-display font-600 outline-none
              transition-all duration-200 placeholder:text-text-3/70
              focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
            style={{ fontFamily: 'inherit' }}
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="px-12 py-4 rounded-[16px] border-none bg-[#6366F1] text-white text-[16px] font-display font-600
              cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
              shadow-[0_6px_28px_rgba(99,102,241,0.3)] disabled:opacity-30"
            style={{ fontFamily: 'inherit' }}
          >
            Get Started
          </button>
        </form>
      </div>
    </div>
  )
}
