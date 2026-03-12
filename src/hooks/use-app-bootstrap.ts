import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { getStoredAccessKey, clearStoredAccessKey, api } from '@/lib/app/api-client'
import { safeStorageGet, safeStorageSet } from '@/lib/app/safe-storage'
import { connectWs, disconnectWs } from '@/lib/ws-client'
import { fetchWithTimeout, isAbortError, isTimeoutError } from '@/lib/fetch-timeout'
import { isDevelopmentLikeRuntime } from '@/lib/runtime/runtime-env'
import { useWs } from '@/hooks/use-ws'
import { useMountedRef } from '@/hooks/use-mounted-ref'
import { resolveSetupDone } from '@/hooks/setup-done-detection'
import type { Agent } from '@/types'

const AUTH_CHECK_TIMEOUT_MS = isDevelopmentLikeRuntime() ? 20_000 : 8_000
const POST_AUTH_BOOTSTRAP_TIMEOUT_MS = isDevelopmentLikeRuntime() ? 20_000 : 8_000

function isExpectedAuthProbeError(err: unknown): boolean {
  return isAbortError(err) || isTimeoutError(err)
}

export function useAppBootstrap() {
  const currentUser = useAppStore((s) => s.currentUser)
  const setUser = useAppStore((s) => s.setUser)
  const hydrated = useAppStore((s) => s._hydrated)
  const hydrate = useAppStore((s) => s.hydrate)
  const loadNetworkInfo = useAppStore((s) => s.loadNetworkInfo)
  const loadSessions = useAppStore((s) => s.loadSessions)
  const loadSettings = useAppStore((s) => s.loadSettings)

  const [authChecked, setAuthChecked] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [setupDone, setSetupDone] = useState<boolean | null>(null)
  const [agentReady, setAgentReady] = useState(false)
  const mountedRef = useMountedRef()

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetchWithTimeout('/api/auth', {}, AUTH_CHECK_TIMEOUT_MS)
      const data = await res.json().catch((err) => {
        console.warn('Failed to parse /api/auth JSON:', err)
        return {}
      })
      if (data?.authenticated === true) {
        if (!mountedRef.current) return
        setAuthenticated(true)
        setAuthChecked(true)
        return
      }
    } catch (err) {
      if (!isExpectedAuthProbeError(err)) {
        console.warn('Auth check probe failed, falling back to stored key:', err)
      }
    }

    const key = getStoredAccessKey()
    if (!key) {
      if (!mountedRef.current) return
      setAuthenticated(false)
      setAuthChecked(true)
      return
    }

    try {
      const res = await fetchWithTimeout('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      }, AUTH_CHECK_TIMEOUT_MS)
      if (res.ok) {
        if (!mountedRef.current) return
        setAuthenticated(true)
      } else {
        clearStoredAccessKey()
        if (!mountedRef.current) return
        setAuthenticated(false)
      }
    } catch (err) {
      if (!isExpectedAuthProbeError(err)) {
        console.warn('Stored key auth check failed:', err)
      }
      clearStoredAccessKey()
      if (!mountedRef.current) return
      setAuthenticated(false)
    } finally {
      if (!mountedRef.current) return
      setAuthChecked(true)
    }
  }, [mountedRef])

  const syncUserFromServer = useCallback(async () => {
    if (currentUser) return
    try {
      const settings = await api<{ userName?: string }>('GET', '/settings', undefined, {
        timeoutMs: POST_AUTH_BOOTSTRAP_TIMEOUT_MS,
        retries: 0,
      })
      if (settings.userName) {
        setUser(settings.userName)
      }
    } catch (err) {
      console.warn('Failed to sync user from server:', err)
    }
  }, [currentUser, setUser])

  useEffect(() => {
    hydrate()
  }, [hydrate])

  useEffect(() => {
    if (!hydrated) return
    if (safeStorageGet('sc_setup_done') === '1') {
      setSetupDone(true)
    }
    const handler = () => setSetupDone(true)
    window.addEventListener('sc:setup-complete', handler)
    return () => window.removeEventListener('sc:setup-complete', handler)
  }, [hydrated])

  useEffect(() => {
    if (hydrated) checkAuth()
  }, [hydrated, checkAuth])

  useEffect(() => {
    if (!authenticated) return
    connectWs()
    syncUserFromServer()
    loadNetworkInfo()
    loadSettings()
    loadSessions()
    return () => { disconnectWs() }
  }, [authenticated, loadNetworkInfo, loadSessions, loadSettings, syncUserFromServer])

  useWs('sessions', loadSessions, 15000)

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
        const targetId = (currentAgentId && agents[currentAgentId])
          ? currentAgentId
          : (appSettings.defaultAgentId && agents[appSettings.defaultAgentId])
            ? appSettings.defaultAgentId
            : Object.values(agents)[0]?.id || null

        if (targetId) {
          await useAppStore.getState().setCurrentAgent(targetId)
        }
      } catch (err) {
        console.warn('Failed to initialize agents:', err)
      }
      if (!cancelled && mountedRef.current) setAgentReady(true)
    })()
    return () => { cancelled = true }
  }, [authenticated, currentUser, mountedRef])

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
        const done = resolveSetupDone(settings, creds, bothFailed)
        if (done) safeStorageSet('sc_setup_done', '1')
        if (!mountedRef.current) return
        setSetupDone(done)
      } catch (err) {
        console.warn('Failed to check setup state:', err)
        if (!cancelled && mountedRef.current) setSetupDone(true)
      }
    })()
    return () => { cancelled = true }
  }, [authenticated, currentUser, mountedRef])

  return {
    hydrated,
    authChecked,
    authenticated,
    setAuthenticated,
    currentUser,
    setupDone,
    setSetupDone,
    agentReady
  }
}
