import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import { validateAccessKey } from './storage'

interface WsClient {
  ws: WebSocket
  topics: Set<string>
}

interface WsHub {
  wss: WebSocketServer
  clients: Set<WsClient>
}

const GK = '__swarmclaw_ws__' as const

function getHub(): WsHub | null {
  return (globalThis as any)[GK] ?? null
}

export function initWsServer() {
  if (getHub()) return

  const port = Number(process.env.WS_PORT) || (Number(process.env.PORT) || 3456) + 1
  const wss = new WebSocketServer({ port, path: '/ws' })
  const clients = new Set<WsClient>()

  const hub: WsHub = { wss, clients }
  ;(globalThis as any)[GK] = hub

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Auth: validate ?key= from upgrade URL
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const key = url.searchParams.get('key') || ''
    if (!validateAccessKey(key)) {
      ws.close(4001, 'Unauthorized')
      return
    }

    const client: WsClient = { ws, topics: new Set() }
    clients.add(client)

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw))
        if (msg.type === 'subscribe' && Array.isArray(msg.topics)) {
          for (const t of msg.topics) {
            if (typeof t === 'string') client.topics.add(t)
          }
        } else if (msg.type === 'unsubscribe' && Array.isArray(msg.topics)) {
          for (const t of msg.topics) client.topics.delete(t)
        }
      } catch {
        // ignore malformed messages
      }
    })

    ws.on('close', () => {
      clients.delete(client)
    })

    ws.on('error', () => {
      clients.delete(client)
    })
  })

  wss.on('error', (err) => {
    console.error('[ws-hub] WebSocket server error:', err.message)
  })

  console.log(`[ws-hub] WebSocket server listening on port ${port}`)
}

export function notify(topic: string, action = 'update', id?: string) {
  const hub = getHub()
  if (!hub) return

  const payload = JSON.stringify(id ? { topic, action, id } : { topic, action })

  for (const client of hub.clients) {
    if (client.topics.has(topic) && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload)
    }
  }
}

/** Send an event with a data payload to subscribed browser clients. */
export function notifyWithPayload(topic: string, data: unknown) {
  const hub = getHub()
  if (!hub) return

  const payload = JSON.stringify({ topic, action: 'event', data })

  for (const client of hub.clients) {
    if (client.topics.has(topic) && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload)
    }
  }
}
