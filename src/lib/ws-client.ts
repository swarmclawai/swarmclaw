type WsCallback = () => void

let ws: WebSocket | null = null
let accessKey = ''
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
const MAX_RECONNECT_DELAY = 30_000
const listeners = new Map<string, Set<WsCallback>>()
let connected = false

function getWsUrl(key: string): string {
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
  const port = process.env.NEXT_PUBLIC_WS_PORT || '3457'
  const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${host}:${port}/ws?key=${encodeURIComponent(key)}`
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
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!accessKey) return
    connect(accessKey)
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
}

function connect(key: string) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  try {
    ws = new WebSocket(getWsUrl(key))
  } catch {
    scheduleReconnect()
    return
  }

  ws.onopen = () => {
    connected = true
    reconnectDelay = 1000
    // Subscribe to all currently registered topics
    const topics = Array.from(listeners.keys())
    if (topics.length > 0) {
      ws?.send(JSON.stringify({ type: 'subscribe', topics }))
    }
  }

  ws.onmessage = handleMessage

  ws.onclose = () => {
    connected = false
    ws = null
    if (accessKey) scheduleReconnect()
  }

  ws.onerror = () => {
    // onclose will fire after this
  }
}

export function connectWs(key: string) {
  accessKey = key
  reconnectDelay = 1000
  connect(key)
}

export function disconnectWs() {
  accessKey = ''
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
