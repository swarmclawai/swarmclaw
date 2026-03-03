'use client'

import { useCallback, useSyncExternalStore } from 'react'

function supportsMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
}

function getMatch(query: string): boolean {
  if (!supportsMatchMedia()) return false
  try {
    return window.matchMedia(query).matches
  } catch {
    return false
  }
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (callback: () => void) => {
      if (!supportsMatchMedia()) return () => {}

      let mql: MediaQueryList
      try {
        mql = window.matchMedia(query)
      } catch {
        return () => {}
      }

      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', callback)
        return () => mql.removeEventListener('change', callback)
      }

      mql.addListener(callback)
      return () => mql.removeListener(callback)
    },
    [query],
  )

  const getSnapshot = () => getMatch(query)

  // Return false during SSR — matches initial client render before hydration
  const getServerSnapshot = () => false

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
