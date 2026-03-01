'use client'

import { useEffect, useRef } from 'react'
import { subscribeWs, unsubscribeWs, isWsConnected } from '@/lib/ws-client'
import { usePageActive } from './use-page-active'

/**
 * Subscribe to a WebSocket topic. Calls `handler` on push events.
 * Falls back to polling at `fallbackMs` when WS is disconnected.
 */
export function useWs(topic: string, handler: () => void, fallbackMs?: number) {
  const isActive = usePageActive()
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const fallbackMsRef = useRef(fallbackMs)
  fallbackMsRef.current = fallbackMs

  // WS subscription — only re-runs when topic changes
  useEffect(() => {
    if (!topic) return

    const cb = () => handlerRef.current()
    subscribeWs(topic, cb)
    return () => { unsubscribeWs(topic, cb) }
  }, [topic])

  // Fallback polling — separate effect so it doesn't tear down WS subscription
  // Pauses when tab is hidden; triggers immediate fetch when tab becomes visible again
  useEffect(() => {
    if (!topic) return

    let fallbackId: ReturnType<typeof setInterval> | null = null
    const cb = () => handlerRef.current()

    // When page becomes visible again, fire an immediate refresh
    if (isActive) {
      cb()
    }

    // Don't run polling while the tab is hidden
    if (!isActive) return

    const startFallback = () => {
      const ms = fallbackMsRef.current
      if (fallbackId || !ms || ms <= 0) return
      fallbackId = setInterval(cb, ms)
    }
    const stopFallback = () => {
      if (fallbackId) {
        clearInterval(fallbackId)
        fallbackId = null
      }
    }

    // Check WS connection state periodically to toggle fallback
    const checkId = setInterval(() => {
      const ms = fallbackMsRef.current
      if (!ms || ms <= 0) {
        stopFallback()
      } else if (isWsConnected()) {
        stopFallback()
      } else {
        startFallback()
      }
    }, 2000)

    // Start fallback immediately if not connected and fallback is enabled
    if (!isWsConnected() && fallbackMsRef.current && fallbackMsRef.current > 0) {
      startFallback()
    }

    return () => {
      stopFallback()
      clearInterval(checkId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, isActive])
}
