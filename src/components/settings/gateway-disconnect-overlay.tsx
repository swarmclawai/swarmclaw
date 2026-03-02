'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { api } from '@/lib/api-client'
import { useAppStore } from '@/stores/use-app-store'

// Module-level gateway status store with subscribe/getSnapshot for useSyncExternalStore
let _status: 'connected' | 'disconnected' | null = null
let _lastCheck = 0
const _listeners = new Set<() => void>()
const POLL_INTERVAL = 30_000

function getSnapshot() {
  return _status
}

function subscribe(cb: () => void) {
  _listeners.add(cb)
  return () => { _listeners.delete(cb) }
}

async function checkGateway() {
  try {
    const res = await api<{ connected: boolean }>('GET', '/openclaw/gateway')
    _status = res.connected ? 'connected' : 'disconnected'
  } catch {
    _status = 'disconnected'
  }
  _lastCheck = Date.now()
  for (const cb of _listeners) cb()
}

export function useGatewayStatus() {
  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    // Initial check if stale
    if (!_status || Date.now() - _lastCheck >= POLL_INTERVAL) {
      checkGateway()
    }
    const interval = setInterval(checkGateway, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [])

  return status
}

export function GatewayDisconnectOverlay() {
  const setActiveView = useAppStore((s) => s.setActiveView)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg/60 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4 p-8 rounded-[20px] border border-white/[0.06] bg-surface/90 max-w-[320px] text-center">
        <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-red-500/10">
          <span className="w-3 h-3 rounded-full bg-red-400" />
        </span>
        <div>
          <h3 className="font-display text-[16px] font-600 text-text mb-1">Gateway Disconnected</h3>
          <p className="text-[13px] text-text-3/60">
            The OpenClaw gateway is offline. Connect to resume chatting with this agent.
          </p>
        </div>
        <button
          onClick={() => {
            setActiveView('settings')
            setSidebarOpen(true)
          }}
          className="px-5 py-2 rounded-[10px] border-none bg-accent-bright text-white text-[13px] font-600 cursor-pointer transition-all hover:brightness-110"
          style={{ fontFamily: 'inherit' }}
        >
          Connect Gateway
        </button>
      </div>
    </div>
  )
}
