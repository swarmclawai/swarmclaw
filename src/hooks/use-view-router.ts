'use client'

import { useEffect, useRef } from 'react'
import { useAppStore } from '@/stores/use-app-store'
import { VIEW_TO_PATH, PATH_TO_VIEW, DEFAULT_VIEW } from '@/lib/view-routes'

export function useViewRouter() {
  const fromPopstate = useRef(false)

  // Mount: read pathname → set active view
  useEffect(() => {
    const view = PATH_TO_VIEW[window.location.pathname]
    if (view) {
      useAppStore.getState().setActiveView(view)
    } else {
      useAppStore.getState().setActiveView(DEFAULT_VIEW)
      window.history.replaceState(null, '', VIEW_TO_PATH[DEFAULT_VIEW])
    }
  }, [])

  // State→URL: push new path when activeView changes
  useEffect(() => {
    let prev = useAppStore.getState().activeView
    const unsub = useAppStore.subscribe((state) => {
      const next = state.activeView
      if (next === prev) return
      prev = next
      if (fromPopstate.current) {
        fromPopstate.current = false
        return
      }
      const targetPath = VIEW_TO_PATH[next]
      if (targetPath && window.location.pathname !== targetPath) {
        window.history.pushState(null, '', targetPath)
      }
    })
    return unsub
  }, [])

  // Popstate: browser back/forward → update view
  useEffect(() => {
    const onPopstate = () => {
      const view = PATH_TO_VIEW[window.location.pathname]
      if (view) {
        fromPopstate.current = true
        useAppStore.getState().setActiveView(view)
      }
    }
    window.addEventListener('popstate', onPopstate)
    return () => window.removeEventListener('popstate', onPopstate)
  }, [])
}
