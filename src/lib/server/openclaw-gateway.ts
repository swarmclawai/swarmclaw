import { WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import { wsConnect, buildOpenClawConnectParams } from '../providers/openclaw'
import { loadAgents, loadCredentials, decryptKey } from './storage'
import { notify, notifyWithPayload } from './ws-hub'

// --- Types ---

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type EventHandler = (payload: unknown) => void

// --- Singleton (HMR-safe) ---

const GK = '__swarmclaw_ocgateway__' as const

interface GatewayState {
  instance: OpenClawGateway | null
}

function getState(): GatewayState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any
  if (!g[GK]) g[GK] = { instance: null }
  return g[GK] as GatewayState
}

// --- Helper: resolve gateway config from first OpenClaw agent ---

interface GatewayConfig {
  wsUrl: string
  token: string | undefined
}

function normalizeWsUrl(raw: string): string {
  let url = raw.replace(/\/+$/, '')
  if (!/^(https?|wss?):\/\//i.test(url)) url = `http://${url}`
  url = url.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:')
  return url.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')
}

export function resolveGatewayConfig(): GatewayConfig | null {
  const agents = loadAgents({ includeTrashed: true })
  const creds = loadCredentials()
  for (const agent of Object.values(agents)) {
    if (agent?.provider !== 'openclaw') continue
    const wsUrl = agent.apiEndpoint
      ? normalizeWsUrl(agent.apiEndpoint)
      : 'ws://127.0.0.1:18789'
    let token: string | undefined
    if (agent.credentialId) {
      const cred = creds[agent.credentialId]
      if (cred?.encryptedKey) {
        try { token = decryptKey(cred.encryptedKey) } catch { /* ignore */ }
      }
    }
    return { wsUrl, token }
  }
  return null
}

export function hasOpenClawAgents(): boolean {
  const agents = loadAgents({ includeTrashed: true })
  return Object.values(agents).some((a) => a?.provider === 'openclaw' && !a.trashedAt)
}

// --- Gateway Client ---

export class OpenClawGateway {
  private ws: WebSocket | null = null
  private pending = new Map<string, PendingRpc>()
  private eventListeners = new Map<string, Set<EventHandler>>()
  private _connected = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 800
  private shouldReconnect = false
  private wsUrl = ''
  private token: string | undefined

  get connected(): boolean { return this._connected }

  async connect(wsUrl: string, token: string | undefined): Promise<boolean> {
    this.wsUrl = wsUrl
    this.token = token
    this.shouldReconnect = true
    return this.doConnect()
  }

  private async doConnect(): Promise<boolean> {
    if (this._connected && this.ws?.readyState === WebSocket.OPEN) return true

    try {
      const result = await wsConnect(this.wsUrl, this.token, true, 15_000)
      if (!result.ok || !result.ws) {
        console.error('[openclaw-gateway] Connect failed:', result.message)
        this.scheduleReconnect()
        return false
      }

      this.ws = result.ws
      this._connected = true
      this.reconnectDelay = 800
      console.log('[openclaw-gateway] Connected to gateway')

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          this.handleMessage(msg)
        } catch { /* ignore malformed */ }
      })

      this.ws.on('close', () => {
        this._connected = false
        this.ws = null
        this.rejectAllPending('Gateway connection closed')
        if (this.shouldReconnect) this.scheduleReconnect()
      })

      this.ws.on('error', () => {
        // onclose fires after this
      })

      return true
    } catch (err: unknown) {
      console.error('[openclaw-gateway] Connect error:', err instanceof Error ? err.message : String(err))
      this.scheduleReconnect()
      return false
    }
  }

  disconnect() {
    this.shouldReconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.rejectAllPending('Disconnecting')
    if (this.ws) {
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
    this._connected = false
    console.log('[openclaw-gateway] Disconnected')
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || !this.shouldReconnect) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.shouldReconnect) return
      this.doConnect().catch(() => {})
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15_000)
  }

  private rejectAllPending(reason: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }

  // --- RPC ---

  rpc(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Gateway not connected'))
      }
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC ${method} timed out`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }))
    })
  }

  // --- Events ---

  on(event: string, handler: EventHandler) {
    let set = this.eventListeners.get(event)
    if (!set) {
      set = new Set()
      this.eventListeners.set(event, set)
    }
    set.add(handler)
  }

  off(event: string, handler: EventHandler) {
    const set = this.eventListeners.get(event)
    if (!set) return
    set.delete(handler)
    if (set.size === 0) this.eventListeners.delete(event)
  }

  private handleMessage(msg: Record<string, unknown>) {
    // RPC response
    if (msg.type === 'res' && typeof msg.id === 'string') {
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) {
          p.resolve(msg.payload)
        } else {
          const errMsg = (msg.error as Record<string, unknown>)?.message
          p.reject(new Error(typeof errMsg === 'string' ? errMsg : 'RPC failed'))
        }
      }
      return
    }

    // Event dispatch
    if (msg.type === 'event' || msg.event) {
      const eventName = (msg.event || msg.type) as string
      const payload = msg.payload ?? msg.data ?? msg

      // Dispatch to registered listeners
      const handlers = this.eventListeners.get(eventName)
      if (handlers) {
        for (const h of handlers) {
          try { h(payload) } catch { /* ignore handler errors */ }
        }
      }

      // Push to browser clients via ws-hub
      if (eventName.startsWith('exec.approval')) {
        notifyWithPayload('openclaw:approvals', { event: eventName, payload })
      } else if (eventName.startsWith('agent')) {
        notify('openclaw:agents')
      } else if (eventName.startsWith('skill')) {
        notify('openclaw:skills')
      }
    }
  }
}

// --- Singleton access ---

export function getGateway(): OpenClawGateway | null {
  return getState().instance
}

export async function ensureGatewayConnected(): Promise<OpenClawGateway | null> {
  const state = getState()
  if (state.instance?.connected) return state.instance

  const config = resolveGatewayConfig()
  if (!config) return null

  if (!state.instance) {
    state.instance = new OpenClawGateway()
  }

  const ok = await state.instance.connect(config.wsUrl, config.token)
  return ok ? state.instance : null
}

export function disconnectGateway() {
  const state = getState()
  if (state.instance) {
    state.instance.disconnect()
    state.instance = null
  }
}

/** Manual connect with explicit URL/token (used by gateway connection panel) */
export async function manualConnect(url?: string, token?: string): Promise<boolean> {
  const state = getState()
  if (state.instance?.connected) {
    state.instance.disconnect()
  }

  const config = resolveGatewayConfig()
  const wsUrl = url ? normalizeWsUrl(url) : config?.wsUrl ?? 'ws://127.0.0.1:18789'
  const resolvedToken = token ?? config?.token

  if (!state.instance) {
    state.instance = new OpenClawGateway()
  }

  return state.instance.connect(wsUrl, resolvedToken)
}
