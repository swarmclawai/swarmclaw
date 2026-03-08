'use client'

import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { initAudioContext } from '@/lib/tts'
import { getStoredAccessKey, clearStoredAccessKey, api } from '@/lib/api-client'
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/safe-storage'
import { connectWs, disconnectWs } from '@/lib/ws-client'
import { fetchWithTimeout } from '@/lib/fetch-timeout'
import { isLocalhostBrowser } from '@/lib/local-observability'
import { useWs } from '@/hooks/use-ws'
import { AccessKeyGate } from '@/components/auth/access-key-gate'
import { UserPicker } from '@/components/auth/user-picker'
import { SetupWizard } from '@/components/auth/setup-wizard'
import { AppLayout } from '@/components/layout/app-layout'
import { useViewRouter } from '@/hooks/use-view-router'
import type { Agent } from '@/types'

const AUTH_CHECK_TIMEOUT_MS = 8_000
const POST_AUTH_BOOTSTRAP_TIMEOUT_MS = 8_000

function FullScreenLoader(props: {
  stage?: string | null
  stalled?: boolean
  onReload?: () => void
  onReset?: () => void
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center bg-bg overflow-hidden select-none">
      {/* Animated orbital ring */}
      <div className="relative w-[120px] h-[120px] mb-8">
        {/* Outer glow pulse */}
        <div
          className="absolute inset-[-20px] rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%)',
            animation: 'sc-glow 2.5s ease-in-out infinite',
          }}
        />

        {/* Orbital ring */}
        <div
          className="absolute inset-0 rounded-full border border-white/[0.06]"
          style={{ animation: 'sc-ring 3s linear infinite' }}
        />

        {/* Orbiting dots */}
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="absolute inset-0"
            style={{
              animation: `sc-orbit 2.4s cubic-bezier(0.4, 0, 0.2, 1) infinite`,
              animationDelay: `${i * -0.4}s`,
            }}
          >
            <div
              className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                width: i === 0 ? 8 : 6,
                height: i === 0 ? 8 : 6,
                background: i === 0 ? '#818CF8' : `rgba(129, 140, 248, ${0.7 - i * 0.1})`,
                boxShadow: i === 0 ? '0 0 12px rgba(99,102,241,0.5)' : 'none',
              }}
            />
          </div>
        ))}

        {/* Center logo mark */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="relative"
            style={{ animation: 'sc-breathe 2.5s ease-in-out infinite' }}
          >
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
              {/* Hexagonal claw mark */}
              <path
                d="M18 4L30 11V25L18 32L6 25V11L18 4Z"
                stroke="rgba(129, 140, 248, 0.3)"
                strokeWidth="1"
                fill="none"
              />
              <path
                d="M18 9L25 13V23L18 27L11 23V13L18 9Z"
                stroke="rgba(129, 140, 248, 0.5)"
                strokeWidth="1.5"
                fill="rgba(99, 102, 241, 0.06)"
              />
              {/* Claw lines */}
              <path d="M14 15L18 20L22 15" stroke="#818CF8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M12 13L18 20L24 13" stroke="rgba(129, 140, 248, 0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </div>

      {/* Brand text */}
      <div
        className="text-[15px] font-display font-700 tracking-[0.15em] uppercase"
        style={{
          background: 'linear-gradient(135deg, rgba(255,255,255,0.6), rgba(129, 140, 248, 0.8))',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          animation: 'sc-text-fade 2s ease-in-out infinite alternate, fade-up 0.6s var(--ease-spring) 0.2s both',
        }}
      >
        SwarmClaw
      </div>

      {/* Loading bar */}
      <div className="mt-4 w-[100px] h-[2px] rounded-full bg-white/[0.06] overflow-hidden" style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.3s both' }}>
        <div
          className="h-full rounded-full bg-accent-bright/60"
          style={{ animation: 'sc-progress 1.5s ease-in-out infinite' }}
        />
      </div>

      {props.stage ? (
        <p
          className="mt-4 text-[12px] text-text-3"
          style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.4s both' }}
        >
          {props.stage}
        </p>
      ) : null}

      {props.stalled ? (
        <div
          className="mt-6 max-w-[360px] px-4 text-center"
          style={{ animation: 'fade-up 0.6s var(--ease-spring) 0.5s both' }}
        >
          <p className="text-[12px] text-text-2">
            Startup is taking longer than expected. This usually means the browser kept stale local state while the dev server restarted.
          </p>
          <div className="mt-4 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={props.onReload}
              className="px-4 py-2 rounded-[12px] border border-white/[0.08] bg-surface text-[12px] text-text-2 transition-colors hover:bg-surface-2"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={props.onReset}
              className="px-4 py-2 rounded-[12px] border border-white/[0.08] bg-transparent text-[12px] text-text-3 transition-colors hover:bg-white/[0.04]"
            >
              Reset Local Session
            </button>
          </div>
        </div>
      ) : null}

      {/* Loading animation keyframes */}
      <style>{`
        @keyframes sc-orbit {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes sc-ring {
          from { transform: rotate(0deg) scale(1); }
          50% { transform: rotate(180deg) scale(1.02); }
          to { transform: rotate(360deg) scale(1); }
        }
        @keyframes sc-breathe {
          0%, 100% { transform: scale(1); opacity: 0.9; }
          50% { transform: scale(1.06); opacity: 1; }
        }
        @keyframes sc-glow {
          0%, 100% { opacity: 0.5; transform: scale(0.9); }
          50% { opacity: 1; transform: scale(1.1); }
        }
        @keyframes sc-text-fade {
          0% { opacity: 0.6; }
          100% { opacity: 1; }
        }
        @keyframes sc-progress {
          0% { width: 0; margin-left: 0; }
          50% { width: 70%; margin-left: 15%; }
          100% { width: 0; margin-left: 100%; }
        }
      `}</style>
    </div>
  )
}

export default function Home() {
  const currentUser = useAppStore((s) => s.currentUser)
  const setUser = useAppStore((s) => s.setUser)
  const hydrated = useAppStore((s) => s._hydrated)
  const hydrate = useAppStore((s) => s.hydrate)
  const loadNetworkInfo = useAppStore((s) => s.loadNetworkInfo)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const loadSettings = useAppStore((s) => s.loadSettings)

  const [authChecked, setAuthChecked] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [bootTimedOut, setBootTimedOut] = useState(false)
  const [setupDone, setSetupDone] = useState<boolean | null>(() => {
    if (safeStorageGet('sc_setup_done') === '1') return true
    return null
  })

  const checkAuth = useCallback(async () => {
    const key = getStoredAccessKey()
    if (!key) {
      try {
        const res = await fetchWithTimeout('/api/auth', {}, AUTH_CHECK_TIMEOUT_MS)
        const data = await res.json().catch(() => ({}))
        setAuthenticated(data?.authenticated === true)
      } catch {
        setAuthenticated(false)
      } finally {
        setAuthChecked(true)
      }
      return
    }

    try {
      const res = await fetchWithTimeout('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      }, AUTH_CHECK_TIMEOUT_MS)
      if (res.ok) {
        setAuthenticated(true)
      } else {
        clearStoredAccessKey()
        setAuthenticated(false)
      }
    } catch {
      clearStoredAccessKey()
      setAuthenticated(false)
    } finally {
      setAuthChecked(true)
    }
  }, [])

  // After auth, try to restore username from server settings
  const syncUserFromServer = useCallback(async () => {
    if (currentUser) return // already have a name locally
    try {
      const settings = await api<{ userName?: string }>('GET', '/settings', undefined, {
        timeoutMs: POST_AUTH_BOOTSTRAP_TIMEOUT_MS,
        retries: 0,
      })
      if (settings.userName) {
        setUser(settings.userName)
      }
    } catch { /* ignore */ }
  }, [currentUser, setUser])

  useEffect(() => {
    hydrate()
  }, [])

  useEffect(() => {
    if (hydrated) checkAuth()
  }, [hydrated, checkAuth])

  useEffect(() => {
    if (!authenticated) return
    const key = getStoredAccessKey()
    if (key) connectWs(key)
    syncUserFromServer()
    loadNetworkInfo()
    loadSettings()
    loadSessions()
    return () => { disconnectWs() }
  }, [authenticated])

  useWs('sessions', loadSessions, 5000)

  useEffect(() => {
    if (!authenticated || !isLocalhostBrowser()) return
    const pollId = setInterval(() => {
      void loadSessions()
    }, 5000)
    return () => clearInterval(pollId)
  }, [authenticated, loadSessions])

  // Auto-select agent's thread on load — resolves a persisted agentId into a session,
  // or falls back to defaultAgentId from settings, then first agent.
  const [agentReady, setAgentReady] = useState(false)
  useEffect(() => {
    if (!authenticated || !currentUser) return
    let cancelled = false
    ;(async () => {
      try {
        const agents = await api<Record<string, Agent>>('GET', '/agents', undefined, {
          timeoutMs: POST_AUTH_BOOTSTRAP_TIMEOUT_MS,
          retries: 0,
        })
        if (cancelled) return
        useAppStore.setState({ agents })

        const { currentAgentId, appSettings } = useAppStore.getState()
        // Priority: persisted agent > settings default > first agent
        const targetId = (currentAgentId && agents[currentAgentId])
          ? currentAgentId
          : (appSettings.defaultAgentId && agents[appSettings.defaultAgentId])
            ? appSettings.defaultAgentId
            : Object.values(agents)[0]?.id || null

        if (targetId) {
          await useAppStore.getState().setCurrentAgent(targetId)
        }
      } catch { /* ignore */ }
      if (!cancelled) setAgentReady(true)
    })()
    return () => { cancelled = true }
  }, [authenticated, currentUser])

  // Check if first-run setup is needed
  useEffect(() => {
    if (!authenticated || !currentUser) return
    let cancelled = false
    ;(async () => {
      try {
        const [settingsResult, credsResult] = await Promise.allSettled([
          api<{ setupCompleted?: boolean }>('GET', '/settings', undefined, {
            timeoutMs: POST_AUTH_BOOTSTRAP_TIMEOUT_MS,
            retries: 0,
          }),
          api<Record<string, unknown>>('GET', '/credentials', undefined, {
            timeoutMs: POST_AUTH_BOOTSTRAP_TIMEOUT_MS,
            retries: 0,
          }),
        ])
        if (cancelled) return
        const settings = settingsResult.status === 'fulfilled' ? settingsResult.value : {}
        const creds = credsResult.status === 'fulfilled' ? credsResult.value : {}
        const bothFailed = settingsResult.status === 'rejected' && credsResult.status === 'rejected'
        const hasCreds = Object.keys(creds).length > 0
        const done = bothFailed ? true : settings.setupCompleted === true || hasCreds
        if (done) safeStorageSet('sc_setup_done', '1')
        setSetupDone(done)
      } catch {
        if (!cancelled) setSetupDone(true) // on error, skip wizard
      }
    })()
    return () => { cancelled = true }
  }, [authenticated, currentUser])

  useEffect(() => {
    const handler = () => {
      initAudioContext()
      document.removeEventListener('click', handler)
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  useEffect(() => {
    const handler = () => {
      disconnectWs()
      setAuthenticated(false)
      setAuthChecked(true)
    }
    window.addEventListener('sc_auth_required', handler)
    return () => window.removeEventListener('sc_auth_required', handler)
  }, [])

  useViewRouter()

  const bootStage = !hydrated
    ? 'Restoring local session'
    : !authChecked
      ? 'Checking access'
      : authenticated && currentUser && setupDone === null
        ? 'Loading setup state'
        : authenticated && currentUser && !agentReady
          ? 'Restoring agent workspace'
          : null

  useEffect(() => {
    if (!bootStage) {
      setBootTimedOut(false)
      return
    }
    const timer = window.setTimeout(() => setBootTimedOut(true), 15_000)
    return () => window.clearTimeout(timer)
  }, [bootStage])

  const reloadApp = useCallback(() => {
    window.location.reload()
  }, [])

  const resetLocalSession = useCallback(() => {
    clearStoredAccessKey()
    disconnectWs()
    safeStorageRemove('sc_user')
    safeStorageRemove('sc_agent')
    safeStorageRemove('sc_setup_done')
    window.location.assign('/')
  }, [])

  if (!hydrated || !authChecked) {
    return (
      <FullScreenLoader
        stage={bootStage}
        stalled={bootTimedOut}
        onReload={reloadApp}
        onReset={resetLocalSession}
      />
    )
  }
  if (!authenticated) return <AccessKeyGate onAuthenticated={() => setAuthenticated(true)} />
  if (!currentUser) return <UserPicker />
  if (setupDone === null || !agentReady) {
    return (
      <FullScreenLoader
        stage={bootStage}
        stalled={bootTimedOut}
        onReload={reloadApp}
        onReset={resetLocalSession}
      />
    )
  }
  if (!setupDone) return <SetupWizard onComplete={() => { safeStorageSet('sc_setup_done', '1'); setSetupDone(true) }} />
  return <AppLayout />
}
