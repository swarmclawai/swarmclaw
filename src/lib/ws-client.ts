import { jitteredBackoff, hmrSingleton } from '@/lib/shared-utils'

type WsCallback = () => void

let ws: WebSocket | null = null
let wsEnabled = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
const MAX_RECONNECT_DELAY = 30_000
const listeners = hmrSingleton('wsClient_listeners', () => new Map<string, Set<WsCallback>>())
let connected = false
const connectionStateListeners = hmrSingleton('wsClient_connectionStateListeners', () => new Set<() => void>())

function getWsUrl(): string {
  if (typeof window === 'undefined') return 'ws://localhost:3457/ws'

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const pagePort = window.location.port
  const buildPort = process.env.NEXT_PUBLIC_WS_PORT || '3457'

  // If the page was loaded on a standard HTTP port (80/443/empty) or a port
  // that doesn't match the expected app port, we're likely behind a reverse
  // proxy. Use the page's host directly so the proxy can route /ws traffic.
  const appPort = String((Number(buildPort) || 3457) - 1) // e.g. 3456
  const behindProxy = !pagePort || pagePort === '80' || pagePort === '443' || pagePort !== appPort
  const wsHost = behindProxy ? window.location.host : `${window.location.hostname}:${buildPort}`

  return `${protocol}://${wsHost}/ws`
}

function handleMessage(event: MessageEvent) {
  try {
    const msg = JSON.parse(event.data)
    const topic = msg.topic as string
    if (!topic) return
    const cbs = listeners.get(topic)
    if (cbs) {
      for (const cb of cbs) cb()
    }
  } catch {
    // ignore malformed
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const delay = jitteredBackoff(1000, reconnectAttempt, MAX_RECONNECT_DELAY)
  reconnectAttempt++
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!wsEnabled) return
    connect()
  }, delay)
}

function connect() {
  if (!wsEnabled) return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  try {
    ws = new WebSocket(getWsUrl())
  } catch {
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    connected = true
    for (const cb of connectionStateListeners) cb()
    reconnectAttempt = 0
    // Subscribe to all currently registered topics
    const topics = Array.from(listeners.keys())
    if (topics.length > 0) {
      ws?.send(JSON.stringify({ type: 'subscribe', topics }))
    }
  }

  ws.onmessage = handleMessage

  ws.onclose = () => {
    connected = false
    for (const cb of connectionStateListeners) cb()
    ws = null
    if (wsEnabled) scheduleReconnect()
  }

  ws.onerror = () => {
    // onclose will fire after this
  }
}

export function connectWs() {
  wsEnabled = true
  reconnectAttempt = 0
  connect()
}

export function disconnectWs() {
  wsEnabled = false
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    ws.onclose = null
    ws.close()
    ws = null
  }
  connected = false
}

export function subscribeWs(topic: string, callback: WsCallback) {
  let set = listeners.get(topic)
  const isNew = !set
  if (!set) {
    set = new Set()
    listeners.set(topic, set)
  }
  set.add(callback)

  // Tell server about new topic subscription
  if (isNew && ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'subscribe', topics: [topic] }))
  }
}

export function unsubscribeWs(topic: string, callback: WsCallback) {
  const set = listeners.get(topic)
  if (!set) return
  set.delete(callback)
  if (set.size === 0) {
    listeners.delete(topic)
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'unsubscribe', topics: [topic] }))
    }
  }
}

export function isWsConnected(): boolean {
  return connected
}

export function onWsStateChange(cb: () => void): void {
  connectionStateListeners.add(cb)
}

export function offWsStateChange(cb: () => void): void {
  connectionStateListeners.delete(cb)
}
