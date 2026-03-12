'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { initAudioContext } from '@/lib/tts'
import { clearStoredAccessKey } from '@/lib/app/api-client'
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/app/safe-storage'
import { disconnectWs } from '@/lib/ws-client'
import { useAppBootstrap } from '@/hooks/use-app-bootstrap'
import { useAppStore } from '@/stores/use-app-store'
import { useMediaQuery } from '@/hooks/use-media-query'
import { useSwipe } from '@/hooks/use-swipe'
import { useWs } from '@/hooks/use-ws'
import { api } from '@/lib/app/api-client'
import { pathToView, useNavigate } from '@/lib/app/navigation'

import { FullScreenLoader } from '@/components/ui/full-screen-loader'
import { SidebarRail } from '@/components/layout/sidebar-rail'
import { ErrorBoundary } from '@/components/layout/error-boundary'
import { SheetLayer } from '@/components/layout/sheet-layer'
import { CommandPalette } from '@/components/shared/command-palette'

import type { AppView } from '@/types'

const STAR_NOTIFICATION_KEY = 'sc_star_notification_v1'
const GITHUB_REPO_URL = 'https://github.com/swarmclawai/swarmclaw'

const AUTH_PATHS = new Set(['/login', '/setup', '/user'])

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const navigateTo = useNavigate()

  const {
    hydrated,
    authChecked,
    authenticated,
    setAuthenticated,
    currentUser,
    setupDone,
    agentReady
  } = useAppBootstrap()

  const [bootTimedOut, setBootTimedOut] = useState(false)
  const [profileSheetOpen, setProfileSheetOpen] = useState(false)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const appSettings = useAppStore((s) => s.appSettings)
  const plugins = useAppStore((s) => s.plugins)
  const loadPlugins = useAppStore((s) => s.loadPlugins)
  const isDesktop = useMediaQuery('(min-width: 768px)')

  const isAuthPage = AUTH_PATHS.has(pathname)

  // Audio context init on first click
  useEffect(() => {
    const handler = () => {
      initAudioContext()
      document.removeEventListener('click', handler)
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  // Auth required event
  useEffect(() => {
    const handler = () => {
      disconnectWs()
      setAuthenticated(false)
    }
    window.addEventListener('sc_auth_required', handler)
    return () => window.removeEventListener('sc_auth_required', handler)
  }, [setAuthenticated])

  // Boot stage for loading indicator
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
      const t = window.setTimeout(() => setBootTimedOut(false), 0)
      return () => window.clearTimeout(t)
    }
    const timer = window.setTimeout(() => setBootTimedOut(true), 15_000)
    return () => window.clearTimeout(timer)
  }, [bootStage])

  const reloadApp = useCallback(() => { window.location.reload() }, [])

  const resetLocalSession = useCallback(() => {
    clearStoredAccessKey()
    disconnectWs()
    safeStorageRemove('sc_user')
    safeStorageRemove('sc_agent')
    safeStorageRemove('sc_setup_done')
    window.location.assign('/')
  }, [])

  // Auth gate redirects
  useEffect(() => {
    if (!hydrated || !authChecked) return
    if (isAuthPage) {
      // Reverse redirect: already authenticated with user → leave auth pages
      if (authenticated && currentUser && setupDone !== false) {
        router.replace('/home')
      }
      return
    }
    if (!authenticated) { router.replace('/login'); return }
    if (!currentUser) { router.replace('/setup'); return }
    if (setupDone === false) { router.replace('/setup'); return }
  }, [hydrated, authChecked, authenticated, currentUser, setupDone, router, isAuthPage])

  // Star notification (one-time)
  useEffect(() => {
    if (!authenticated) return
    if (safeStorageGet(STAR_NOTIFICATION_KEY)) return
    safeStorageSet(STAR_NOTIFICATION_KEY, '1')
    void api('POST', '/notifications', {
      type: 'info',
      title: 'Enjoying SwarmClaw?',
      message: 'If SwarmClaw helps your workflow, please star the GitHub repo to support the project.',
      actionLabel: 'Star on GitHub',
      actionUrl: GITHUB_REPO_URL,
      entityType: 'support',
      entityId: 'github-star',
      dedupKey: 'support:github-star',
    }).then(() => {
      void useAppStore.getState().loadNotifications()
    }).catch(() => {})
  }, [authenticated])

  // Theme hue
  useEffect(() => {
    const hue = appSettings.themeHue
    if (hue) {
      document.documentElement.style.setProperty('--neutral-tint', hue)
    }
  }, [appSettings.themeHue])

  // View validity check
  const isViewEnabled = useCallback((view: AppView) => {
    if (view === 'projects') return appSettings.projectManagementEnabled !== false
    if (view === 'tasks') return appSettings.taskManagementEnabled !== false
    if (view === 'chatrooms') return plugins['chatroom']?.enabled !== false
    if (view === 'schedules') return plugins['schedule']?.enabled !== false
    if (view === 'memory') return plugins['memory']?.enabled !== false
    if (view === 'connectors') return plugins['connectors']?.enabled !== false
    if (view === 'webhooks') return plugins['http']?.enabled !== false
    if (view === 'wallets') return plugins['wallet']?.enabled !== false
    if (view === 'logs') return plugins['monitor']?.enabled !== false
    return true
  }, [appSettings.projectManagementEnabled, appSettings.taskManagementEnabled, plugins])

  // Redirect disabled views
  useEffect(() => {
    if (isAuthPage) return
    const currentView = pathToView(pathname)
    if (currentView && !isViewEnabled(currentView)) {
      router.replace('/home')
    }
  }, [pathname, isViewEnabled, router, isAuthPage])

  // Plugin sidebar items
  const refreshPluginState = useCallback(() => {
    void loadPlugins()
  }, [loadPlugins])

  useEffect(() => { refreshPluginState() }, [refreshPluginState])
  useWs('plugins', refreshPluginState, 30000)

  // Keyboard shortcuts
  const handleShortcutKey = useCallback((e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault()
      const state = useAppStore.getState()
      const defaultAgentId = state.appSettings.defaultAgentId && state.agents[state.appSettings.defaultAgentId]
        ? state.appSettings.defaultAgentId
        : Object.values(state.agents)[0]?.id || null
      if (defaultAgentId) {
        navigateTo('agents', defaultAgentId)
      } else {
        navigateTo('agents')
      }
      return
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
      const state = useAppStore.getState()
      if (state.appSettings.taskManagementEnabled === false) return
      e.preventDefault()
      navigateTo('tasks')
    }
  }, [navigateTo])

  useEffect(() => {
    window.addEventListener('keydown', handleShortcutKey)
    return () => window.removeEventListener('keydown', handleShortcutKey)
  }, [handleShortcutKey])

  // Swipe for mobile sidebar
  const swipeHandlers = useSwipe({
    onSwipe: (dir) => {
      if (isDesktop) return
      if (dir === 'right') setSidebarOpen(true)
      else setSidebarOpen(false)
    },
    leftSwipeEnabled: !isDesktop && sidebarOpen,
  })

  // Auth pages render plain (no dashboard chrome)
  if (isAuthPage) {
    return <>{children}</>
  }

  // Show loading while booting
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

  // Redirect happens in effect above; show loader while waiting
  if (!authenticated || !currentUser || setupDone === null || !agentReady || setupDone === false) {
    return (
      <FullScreenLoader
        stage={bootStage}
        stalled={bootTimedOut}
        onReload={reloadApp}
        onReset={resetLocalSession}
      />
    )
  }

  return (
    <div
      className="h-full flex overflow-hidden"
      onTouchStart={isDesktop ? undefined : swipeHandlers.onTouchStart}
      onTouchMove={isDesktop ? undefined : swipeHandlers.onTouchMove}
      onTouchEnd={isDesktop ? undefined : swipeHandlers.onTouchEnd}
    >
      {/* Desktop: Navigation rail */}
      {isDesktop && (
        <SidebarRail onSwitchUser={() => setProfileSheetOpen(true)} isViewEnabled={isViewEnabled} />
      )}

      {/* Mobile: Same sidebar as desktop, rendered as full-width overlay */}
      {!isDesktop && sidebarOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
          <div
            className="relative h-full overflow-y-auto overscroll-contain"
            style={{ animation: 'slide-in-left 0.25s cubic-bezier(0.16, 1, 0.3, 1)' }}
          >
            <SidebarRail mobile onSwitchUser={() => setProfileSheetOpen(true)} isViewEnabled={isViewEnabled} />
          </div>
        </div>
      )}

      {/* Main content — panels come from route layouts, not here */}
      <ErrorBoundary>
        {children}
      </ErrorBoundary>

      <CommandPalette />
      <SheetLayer profileSheetOpen={profileSheetOpen} setProfileSheetOpen={setProfileSheetOpen} />
    </div>
  )
}
