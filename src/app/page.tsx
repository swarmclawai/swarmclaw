'use client'

import { useEffect, useState, useCallback } from 'react'
import { initAudioContext } from '@/lib/tts'
import { clearStoredAccessKey } from '@/lib/api-client'
import { safeStorageRemove, safeStorageSet } from '@/lib/safe-storage'
import { disconnectWs } from '@/lib/ws-client'
import { useViewRouter } from '@/hooks/use-view-router'
import { useAppBootstrap } from '@/hooks/use-app-bootstrap'

import { AccessKeyGate } from '@/components/auth/access-key-gate'
import { UserPicker } from '@/components/auth/user-picker'
import { SetupWizard } from '@/components/auth/setup-wizard'
import { AppLayout } from '@/components/layout/app-layout'
import { FullScreenLoader } from '@/components/ui/full-screen-loader'

export default function Home() {
  const {
    hydrated,
    authChecked,
    authenticated,
    setAuthenticated,
    currentUser,
    setupDone,
    setSetupDone,
    agentReady
  } = useAppBootstrap()

  const [bootTimedOut, setBootTimedOut] = useState(false)

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
      // Note: we can't fully control authChecked here unless we pass a setter from useAppBootstrap,
      // but usually auth dropping just sets authenticated to false.
    }
    window.addEventListener('sc_auth_required', handler)
    return () => window.removeEventListener('sc_auth_required', handler)
  }, [setAuthenticated])

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
      // Defer resetting to avoid synchronous state update in effect
      const t = window.setTimeout(() => setBootTimedOut(false), 0)
      return () => window.clearTimeout(t)
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
