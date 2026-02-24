'use client'

import { useState, useEffect } from 'react'
import { setStoredAccessKey } from '@/lib/api-client'

interface AccessKeyGateProps {
  onAuthenticated: () => void
}

export function AccessKeyGate({ onAuthenticated }: AccessKeyGateProps) {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(true)

  // First-time setup state
  const [firstTime, setFirstTime] = useState(false)
  const [generatedKey, setGeneratedKey] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    fetch('/api/auth')
      .then((r) => r.json())
      .then((data) => {
        if (data.firstTime && data.key) {
          setFirstTime(true)
          setGeneratedKey(data.key)
        }
      })
      .catch(() => {})
      .finally(() => setChecking(false))
  }, [])

  const handleCopyKey = async () => {
    try {
      await navigator.clipboard.writeText(generatedKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback: select the text
    }
  }

  const handleClaimKey = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: generatedKey }),
      })
      if (res.ok) {
        setStoredAccessKey(generatedKey)
        onAuthenticated()
      }
    } catch {
      setError('Connection failed')
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = key.trim()
    if (!trimmed) return

    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: trimmed }),
      })
      if (res.ok) {
        setStoredAccessKey(trimmed)
        onAuthenticated()
      } else {
        setError('Invalid access key')
        setKey('')
      }
    } catch {
      setError('Connection failed')
    } finally {
      setLoading(false)
    }
  }

  if (checking) return null

  return (
    <div className="h-full flex flex-col items-center justify-center px-8 bg-bg relative overflow-hidden">
      {/* Atmospheric gradient mesh */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute top-[30%] left-[50%] -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px]"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(99,102,241,0.06) 0%, transparent 70%)',
            animation: 'glow-pulse 6s ease-in-out infinite',
          }}
        />
      </div>

      <div
        className="relative max-w-[440px] w-full text-center"
        style={{ animation: 'fade-in 0.6s cubic-bezier(0.16, 1, 0.3, 1)' }}
      >
        {/* Lock / Key icon */}
        <div className="flex justify-center mb-6">
          <div className="relative w-12 h-12 flex items-center justify-center">
            <svg
              width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
              className="text-accent-bright"
            >
              {firstTime ? (
                <>
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                </>
              ) : (
                <>
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </>
              )}
            </svg>
            <div className="absolute inset-0 blur-xl bg-accent-bright/20" />
          </div>
        </div>

        {firstTime ? (
          /* ── First-time setup: show the generated key ── */
          <>
            <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
              Your Access Key
            </h1>
            <p className="text-[14px] text-text-2 mb-8">
              This key was generated for your server. Copy it somewhere safe — you&apos;ll need it to connect from other devices.
            </p>

            {/* Key display */}
            <div className="mb-3">
              <div
                className="inline-flex items-center gap-3 px-5 py-3.5 rounded-[14px] border border-white/[0.08] bg-surface
                  cursor-pointer hover:border-accent-bright/20 transition-all duration-200"
                onClick={handleCopyKey}
              >
                <code className="text-[15px] font-mono text-accent-bright tracking-wide select-all">
                  {generatedKey}
                </code>
                <svg
                  width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className="text-text-3 shrink-0"
                >
                  {copied ? (
                    <path d="M20 6L9 17l-5-5" />
                  ) : (
                    <>
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </>
                  )}
                </svg>
              </div>
            </div>

            <div className="relative h-5 mb-8">
              <p
                className="absolute inset-x-0 text-[12px] transition-all duration-300"
                style={{
                  opacity: copied ? 0 : 1,
                  transform: copied ? 'translateY(-4px)' : 'translateY(0)',
                }}
              >
                <span className="text-text-3">Click to copy &middot; Also saved in </span>
                <code className="text-text-2">.env.local</code>
              </p>
              <p
                className="absolute inset-x-0 text-[12px] text-emerald-400 font-medium transition-all duration-300"
                style={{
                  opacity: copied ? 1 : 0,
                  transform: copied ? 'translateY(0)' : 'translateY(4px)',
                }}
              >
                Key copied to clipboard
              </p>
            </div>

            <button
              onClick={handleClaimKey}
              disabled={loading}
              className="px-12 py-4 rounded-[16px] border-none bg-[#6366F1] text-white text-[16px] font-display font-600
                cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                shadow-[0_6px_28px_rgba(99,102,241,0.3)] disabled:opacity-30"
            >
              {loading ? 'Connecting...' : 'Continue'}
            </button>
          </>
        ) : (
          /* ── Returning user: enter key ── */
          <>
            <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
              Connect
            </h1>
            <p className="text-[14px] text-text-2 mb-2">
              Enter the access key to connect to this server.
            </p>
            <p className="text-[12px] text-text-3 mb-8">
              You can find it in <code className="text-text-2">.env.local</code> in the project root.
            </p>

            <form onSubmit={handleSubmit} className="flex flex-col items-center gap-4">
              <input
                type="password"
                value={key}
                onChange={(e) => { setKey(e.target.value); setError('') }}
                placeholder="Access key"
                autoFocus
                autoComplete="off"
                className="w-full max-w-[320px] px-6 py-4 rounded-[16px] border border-white/[0.08] bg-surface
                  text-text text-[16px] text-center font-mono outline-none
                  transition-all duration-200 placeholder:text-text-3/70
                  focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
              />

              {error && (
                <p className="text-[13px] text-red-400">{error}</p>
              )}

              <button
                type="submit"
                disabled={!key.trim() || loading}
                className="px-12 py-4 rounded-[16px] border-none bg-[#6366F1] text-white text-[16px] font-display font-600
                  cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                  shadow-[0_6px_28px_rgba(99,102,241,0.3)] disabled:opacity-30"
              >
                {loading ? 'Connecting...' : 'Connect'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
