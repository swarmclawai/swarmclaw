import { WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import { wsConnect, buildOpenClawConnectParams } from '@/lib/providers/openclaw'
import { deriveOpenClawWsUrl } from '@/lib/openclaw/openclaw-endpoint'
import { loadAgents, loadCredentials, decryptKey } from '../storage'
import { notify, notifyWithPayload } from '../ws-hub'
import { getGatewayProfile, getGatewayProfiles, resolvePrimaryAgentRoute } from '@/lib/server/agents/agent-runtime-config'
import { errorMessage, hmrSingleton } from '@/lib/shared-utils'

// --- Types ---

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type EventHandler = (payload: unknown) => void

// --- Singleton (HMR-safe) ---

interface GatewayState {
  instances: Map<string, OpenClawGateway>
  activeKey: string | null
}

function getState(): GatewayState {
  return hmrSingleton<GatewayState>('__swarmclaw_ocgateway__', () => ({
    instances: new Map<string, OpenClawGateway>(),
    activeKey: null,
  }))
}

// --- Helper: resolve gateway config from first OpenClaw agent ---

interface GatewayConfig {
  key: string
  profileId?: string | null
  wsUrl: string
  token: string | undefined
}

function normalizeWsUrl(raw: string): string {
  let url = raw.replace(/\/+$/, '')
  if (!/^(https?|wss?):\/\//i.test(url)) url = `http://${url}`
  url = url.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:')
  return url.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')
}

function resolveTokenForCredential(credentialId?: string | null): string | undefined {
  const id = typeof credentialId === 'string' && credentialId.trim() ? credentialId.trim() : ''
  if (!id) return undefined
  const creds = loadCredentials()
  const cred = creds[id]
  if (!cred?.encryptedKey) return undefined
  try {
    return decryptKey(cred.encryptedKey)
  } catch {
    return undefined
  }
}

export function resolveGatewayConfig(target?: {
  profileId?: string | null
  agentId?: string | null
}): GatewayConfig | null {
  const profileId = typeof target?.profileId === 'string' ? target.profileId.trim() : ''
  if (profileId) {
    const profile = getGatewayProfile(profileId)
    if (!profile) return null
    return {
      key: `profile:${profile.id}`,
      profileId: profile.id,
      wsUrl: profile.wsUrl ? normalizeWsUrl(profile.wsUrl) : deriveOpenClawWsUrl(profile.endpoint),
      token: resolveTokenForCredential(profile.credentialId),
    }
  }

  const agentId = typeof target?.agentId === 'string' ? target.agentId.trim() : ''
  if (agentId) {
    const agents = loadAgents({ includeTrashed: true })
    const agent = agents[agentId]
    const route = resolvePrimaryAgentRoute(agent)
    if (route?.provider === 'openclaw') {
      const routeProfile = route.gatewayProfileId ? getGatewayProfile(route.gatewayProfileId) : null
      return {
        key: route.gatewayProfileId ? `profile:${route.gatewayProfileId}` : `agent:${agentId}`,
        profileId: route.gatewayProfileId ?? null,
        wsUrl: routeProfile?.wsUrl
          ? normalizeWsUrl(routeProfile.wsUrl)
          : route.apiEndpoint
            ? deriveOpenClawWsUrl(route.apiEndpoint)
            : 'ws://127.0.0.1:18789',
        token: resolveTokenForCredential(route.credentialId),
      }
    }
  }

  const gatewayProfiles = getGatewayProfiles('openclaw')
  if (gatewayProfiles[0]) {
    const profile = gatewayProfiles[0]
    return {
      key: `profile:${profile.id}`,
      profileId: profile.id,
      wsUrl: profile.wsUrl ? normalizeWsUrl(profile.wsUrl) : deriveOpenClawWsUrl(profile.endpoint),
      token: resolveTokenForCredential(profile.credentialId),
    }
  }

  const agents = loadAgents({ includeTrashed: true })
  for (const agent of Object.values(agents)) {
    if (agent?.provider !== 'openclaw') continue
    const wsUrl = agent.apiEndpoint
      ? deriveOpenClawWsUrl(agent.apiEndpoint)
      : 'ws://127.0.0.1:18789'
    return {
      key: `agent:${agent.id}`,
      profileId: agent.gatewayProfileId ?? null,
      wsUrl,
      token: resolveTokenForCredential(agent.credentialId),
    }
  }
  return null
}

export function hasOpenClawAgents(): boolean {
  if (getGatewayProfiles('openclaw').length > 0) return true
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
  private consecutiveFailures = 0
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
      this.consecutiveFailures = 0
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
      console.error('[openclaw-gateway] Connect error:', errorMessage(err))
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
    this.consecutiveFailures++
    // After many failures, back off to 10 minutes to avoid hammering a down server
    const maxDelay = this.consecutiveFailures >= 10 ? 600_000 : 15_000
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.shouldReconnect) return
      this.doConnect().catch(() => {})
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, maxDelay)
    if (this.consecutiveFailures === 1 || this.consecutiveFailures % 5 === 0) {
      console.log(`[openclaw-gateway] ${this.consecutiveFailures} consecutive failure${this.consecutiveFailures > 1 ? 's' : ''}, next retry in ${Math.round(this.reconnectDelay / 1000)}s`)
    }
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

export function getGateway(profileId?: string | null): OpenClawGateway | null {
  const state = getState()
  const key = typeof profileId === 'string' && profileId.trim() ? `profile:${profileId.trim()}` : null
  if (key) {
    return state.instances.get(key) || null
  }
  if (state.activeKey) {
    return state.instances.get(state.activeKey) || null
  }
  for (const instance of state.instances.values()) {
    if (instance.connected) return instance
  }
  return null
}

export async function ensureGatewayConnected(target?: {
  profileId?: string | null
  agentId?: string | null
}): Promise<OpenClawGateway | null> {
  const state = getState()
  const config = resolveGatewayConfig(target)
  if (!config) return null
  const existing = state.instances.get(config.key)
  if (existing?.connected) {
    state.activeKey = config.key
    return existing
  }

  const instance = existing || new OpenClawGateway()
  state.instances.set(config.key, instance)
  const ok = await instance.connect(config.wsUrl, config.token)
  if (ok) {
    state.activeKey = config.key
    return instance
  }
  return null
}

export function disconnectGateway(profileId?: string | null) {
  const state = getState()
  const key = typeof profileId === 'string' && profileId.trim() ? `profile:${profileId.trim()}` : null
  if (key) {
    const instance = state.instances.get(key)
    if (instance) {
      instance.disconnect()
      state.instances.delete(key)
      if (state.activeKey === key) state.activeKey = null
    }
    return
  }
  for (const [instanceKey, instance] of state.instances.entries()) {
    instance.disconnect()
    state.instances.delete(instanceKey)
  }
  state.activeKey = null
}

/** Manual connect with explicit URL/token (used by gateway connection panel) */
export async function manualConnect(url?: string, token?: string, profileId?: string | null): Promise<boolean> {
  const state = getState()
  const config = resolveGatewayConfig({ profileId: profileId || null })
  const key = profileId ? `profile:${profileId}` : '__manual__'
  const instance = state.instances.get(key) || new OpenClawGateway()
  if (instance.connected) {
    instance.disconnect()
  }
  state.instances.set(key, instance)
  const wsUrl = url ? normalizeWsUrl(url) : config?.wsUrl ?? 'ws://127.0.0.1:18789'
  const resolvedToken = token ?? config?.token
  const ok = await instance.connect(wsUrl, resolvedToken)
  if (ok) {
    state.activeKey = key
  }
  return ok
}
