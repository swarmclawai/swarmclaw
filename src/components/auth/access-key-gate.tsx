'use client'

import { useState, useEffect } from 'react'
import { setStoredAccessKey } from '@/lib/app/api-client'
import { fetchWithTimeout, isAbortError, isTimeoutError } from '@/lib/fetch-timeout'

interface AccessKeyGateProps {
  onAuthenticated: () => void
}

const AUTH_CHECK_TIMEOUT_MS = 8_000

function isExpectedAuthCheckError(err: unknown): boolean {
  return isAbortError(err) || isTimeoutError(err)
}

export function AccessKeyGate({ onAuthenticated }: AccessKeyGateProps) {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(true)

  // First-time setup state
  const [firstTime, setFirstTime] = useState(false)
  const [generatedKey, setGeneratedKey] = useState('')
  const [showOverride, setShowOverride] = useState(false)
  const [keyCopied, setKeyCopied] = useState(false)
  const [firstTimeStep, setFirstTimeStep] = useState<'show-key' | 'confirm' | 'paste-key'>('show-key')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetchWithTimeout('/api/auth', {}, AUTH_CHECK_TIMEOUT_MS)
        const data = await res.json().catch(() => ({}))
        if (!cancelled) {
          if (data.firstTime) {
            setFirstTime(true)
            if (data.generatedKey) setGeneratedKey(data.generatedKey)
          }
        }
      } catch (err) {
        if (!isExpectedAuthCheckError(err)) {
          console.error('Auth check failed:', err)
        }
      } finally {
        if (!cancelled) setChecking(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = key.trim()
    if (!trimmed) return

    setLoading(true)
    setError('')

    try {
      const res = await fetchWithTimeout('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: trimmed }),
      }, AUTH_CHECK_TIMEOUT_MS)
      if (res.ok) {
        setStoredAccessKey(trimmed)
        onAuthenticated()
      } else {
        const payload = await res.json().catch(() => null) as { error?: unknown } | null
        setError(typeof payload?.error === 'string' && payload.error.trim() ? payload.error : 'Invalid access key')
        setKey('')
      }
    } catch (err) {
      const message = err instanceof Error && err.message.trim() ? err.message : 'Connection failed'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  if (checking) return (
    <div className="h-full flex items-center justify-center bg-bg">
      <div
        className="h-6 w-6 rounded-full border-2 border-white/[0.08] border-t-accent-bright"
        style={{ animation: 'spin 0.8s linear infinite' }}
      />
    </div>
  )

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

      <div className="relative max-w-[440px] w-full text-center">
        {/* Lock / Key icon */}
        <div className="flex justify-center mb-6" style={{ animation: 'spring-in 0.6s var(--ease-spring)' }}>
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
          /* ── First-time setup: 3-step state machine ── */
          <>
            {firstTimeStep === 'show-key' && (
              <>
                <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.1s both' }}>
                  <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
                    First-Time Setup
                  </h1>
                  <p className="text-[14px] text-text-2 mb-6">
                    Your access key has been generated. Copy it somewhere safe — you&apos;ll need it to reconnect.
                  </p>
                </div>

                {generatedKey ? (
                  <div className="flex flex-col items-center gap-4">
                    <div
                      className="w-full max-w-[380px] px-5 py-4 rounded-[16px] border border-white/[0.08] bg-surface
                        flex items-center justify-between gap-3"
                      style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.2s both' }}
                    >
                      <code className="text-text text-[14px] font-mono select-all truncate flex-1 text-center">{generatedKey}</code>
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(generatedKey)
                          setKeyCopied(true)
                          setTimeout(() => setKeyCopied(false), 2000)
                        }}
                        className="shrink-0 px-3 py-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] text-[12px] text-text-2
                          cursor-pointer hover:bg-white/[0.08] transition-all duration-200"
                      >
                        {keyCopied ? 'Copied' : 'Copy'}
                      </button>
                    </div>

                    <p className="text-[12px] text-text-3 max-w-[340px]" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.3s both' }}>
                      Also saved to <code className="text-text-2">.env.local</code> in your project root.
                    </p>

                    {error && (
                      <p className="text-[13px] text-red-400" style={{ animation: 'ai-shake 0.5s' }}>{error}</p>
                    )}

                    <div className="flex flex-col items-center gap-3" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.4s both' }}>
                      <button
                        type="button"
                        onClick={() => setFirstTimeStep('confirm')}
                        className="px-12 py-4 rounded-[16px] border-none bg-accent-bright text-white text-[16px] font-display font-600
                          cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                          shadow-[0_6px_28px_rgba(99,102,241,0.3)]"
                      >
                        Continue
                      </button>

                      {!showOverride ? (
                        <button
                          type="button"
                          onClick={() => setShowOverride(true)}
                          className="bg-transparent border-none text-[12px] text-text-3 cursor-pointer hover:text-text-2 transition-colors"
                        >
                          Use a different key
                        </button>
                      ) : (
                        <form
                          onSubmit={async (e) => {
                            e.preventDefault()
                            const trimmed = key.trim()
                            if (!trimmed) return
                            setLoading(true)
                            setError('')
                            try {
                              const res = await fetchWithTimeout('/api/auth', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ key: trimmed, override: true }),
                              }, AUTH_CHECK_TIMEOUT_MS)
                              if (res.ok) {
                                setStoredAccessKey(trimmed)
                                onAuthenticated()
                              } else {
                                const payload = await res.json().catch(() => null) as { error?: unknown } | null
                                setError(typeof payload?.error === 'string' && payload.error.trim() ? payload.error : 'Key must be at least 8 characters')
                              }
                            } catch (err) {
                              const message = err instanceof Error && err.message.trim() ? err.message : 'Connection failed'
                              setError(message)
                            } finally {
                              setLoading(false)
                            }
                          }}
                          className="flex flex-col items-center gap-3 w-full"
                        >
                          <input
                            type="password"
                            value={key}
                            onChange={(e) => { setKey(e.target.value); setError('') }}
                            placeholder="Enter custom access key"
                            autoFocus
                            autoComplete="off"
                            className="w-full max-w-[320px] px-6 py-4 rounded-[16px] border border-white/[0.08] bg-surface
                              text-text text-[16px] text-center font-mono outline-none
                              transition-all duration-200 placeholder:text-text-3/70
                              focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                          />
                          <button
                            type="submit"
                            disabled={loading || !key.trim()}
                            className="px-8 py-3 rounded-[12px] border border-white/[0.08] bg-white/[0.04] text-text text-[14px] font-display font-600
                              cursor-pointer hover:bg-white/[0.08] transition-all duration-200 disabled:opacity-30"
                          >
                            {loading ? 'Saving...' : 'Use this key instead'}
                          </button>
                        </form>
                      )}
                    </div>
                  </div>
                ) : (
                  /* Fallback if generated key wasn't returned (e.g. key was set via env var) */
                  <form onSubmit={handleSubmit} className="flex flex-col items-center gap-4">
                    <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.2s both', width: '100%', display: 'flex', justifyContent: 'center' }}>
                      <input
                        type="password"
                        value={key}
                        onChange={(e) => { setKey(e.target.value); setError('') }}
                        placeholder="Enter access key from terminal"
                        autoFocus
                        autoComplete="off"
                        className="w-full max-w-[320px] px-6 py-4 rounded-[16px] border border-white/[0.08] bg-surface
                          text-text text-[16px] text-center font-mono outline-none
                          transition-all duration-200 placeholder:text-text-3/70
                          focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                      />
                    </div>

                    {error && (
                      <p className="text-[13px] text-red-400" style={{ animation: 'ai-shake 0.5s' }}>{error}</p>
                    )}

                    <p className="text-[12px] text-text-3 max-w-[340px]" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.3s both' }}>
                      The access key is shown in the terminal on first launch and saved to <code className="text-text-2">.env.local</code>.
                    </p>

                    <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.4s both' }}>
                      <button
                        type="submit"
                        disabled={loading || !key.trim()}
                        className="px-12 py-4 rounded-[16px] border-none bg-accent-bright text-white text-[16px] font-display font-600
                          cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                          shadow-[0_6px_28px_rgba(99,102,241,0.3)] disabled:opacity-30"
                      >
                        {loading ? 'Connecting...' : 'Connect'}
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}

            {firstTimeStep === 'confirm' && (
              <div className="flex flex-col items-center gap-4">
                <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.1s both' }}>
                  <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
                    Save Your Access Key
                  </h1>
                  <p className="text-[14px] text-text-2 mb-6 max-w-[380px]">
                    Please make sure you&apos;ve copied your access key. If you lose it, you can find it
                    in <code className="text-text-2">.env.local</code> in your project root.
                  </p>
                </div>

                <div className="flex items-center gap-3" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.2s both' }}>
                  <button
                    type="button"
                    onClick={() => setFirstTimeStep('show-key')}
                    className="px-8 py-4 rounded-[16px] border border-white/[0.08] bg-white/[0.04] text-text text-[16px] font-display font-600
                      cursor-pointer hover:bg-white/[0.08] transition-all duration-200"
                  >
                    Go Back
                  </button>
                  <button
                    type="button"
                    onClick={() => { setKey(''); setError(''); setFirstTimeStep('paste-key') }}
                    className="px-8 py-4 rounded-[16px] border-none bg-accent-bright text-white text-[16px] font-display font-600
                      cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                      shadow-[0_6px_28px_rgba(99,102,241,0.3)]"
                  >
                    I&apos;ve Saved It
                  </button>
                </div>
              </div>
            )}

            {firstTimeStep === 'paste-key' && (
              <div className="flex flex-col items-center gap-4">
                <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.1s both' }}>
                  <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
                    Enter Your Access Key
                  </h1>
                  <p className="text-[14px] text-text-2 mb-6">
                    Paste the access key you just saved to connect.
                  </p>
                </div>

                <form onSubmit={handleSubmit} className="flex flex-col items-center gap-4">
                  <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.2s both', width: '100%', display: 'flex', justifyContent: 'center' }}>
                    <input
                      type="password"
                      value={key}
                      onChange={(e) => { setKey(e.target.value); setError('') }}
                      placeholder="Paste access key"
                      autoFocus
                      autoComplete="off"
                      className="w-full max-w-[320px] px-6 py-4 rounded-[16px] border border-white/[0.08] bg-surface
                        text-text text-[16px] text-center font-mono outline-none
                        transition-all duration-200 placeholder:text-text-3/70
                        focus:border-accent-bright/30 focus:shadow-[0_0_30px_rgba(99,102,241,0.1)]"
                    />
                  </div>

                  {error && (
                    <p className="text-[13px] text-red-400" style={{ animation: 'ai-shake 0.5s' }}>{error}</p>
                  )}

                  <div className="flex flex-col items-center gap-3" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.3s both' }}>
                    <button
                      type="submit"
                      disabled={!key.trim() || loading}
                      className="px-12 py-4 rounded-[16px] border-none bg-accent-bright text-white text-[16px] font-display font-600
                        cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                        shadow-[0_6px_28px_rgba(99,102,241,0.3)] disabled:opacity-30"
                    >
                      {loading ? 'Connecting...' : 'Connect'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setKey(''); setError(''); setFirstTimeStep('show-key') }}
                      className="bg-transparent border-none text-[12px] text-text-3 cursor-pointer hover:text-text-2 transition-colors"
                    >
                      Go back
                    </button>
                  </div>
                </form>
              </div>
            )}
          </>
        ) : (
          /* ── Returning user: enter key ── */
          <>
            <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.1s both' }}>
              <h1 className="font-display text-[36px] font-800 leading-[1.05] tracking-[-0.04em] mb-3">
                Connect
              </h1>
              <p className="text-[14px] text-text-2 mb-2">
                Enter the access key to connect to this server.
              </p>
              <p className="text-[12px] text-text-3 mb-8">
                You can find it in <code className="text-text-2">.env.local</code> in the project root.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col items-center gap-4">
              <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.2s both', width: '100%', display: 'flex', justifyContent: 'center' }}>
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
              </div>

              {error && (
                <p className="text-[13px] text-red-400" style={{ animation: 'ai-shake 0.5s' }}>{error}</p>
              )}

              <div style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.3s both' }}>
                <button
                  type="submit"
                  disabled={!key.trim() || loading}
                  className="px-12 py-4 rounded-[16px] border-none bg-accent-bright text-white text-[16px] font-display font-600
                    cursor-pointer hover:brightness-110 active:scale-[0.97] transition-all duration-200
                    shadow-[0_6px_28px_rgba(99,102,241,0.3)] disabled:opacity-30"
                >
                  {loading ? 'Connecting...' : 'Connect'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
