import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { PlatformConnector, ConnectorInstance, InboundMessage } from './types'

/**
 * OpenClaw gateway connector using the current WS protocol:
 * - server emits `event: connect.challenge`
 * - client sends `req(connect, params)`
 * - gateway responds via `res` payload `hello-ok`
 * - chat traffic is event `chat` and RPC method `chat.send`
 */

const PROTOCOL_VERSION = 3
const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 30_000
const RPC_TIMEOUT_MS = 25_000
const CONNECT_DELAY_FALLBACK_MS = 750
const CONNECT_HELLO_TIMEOUT_MS = 20_000
const DEFAULT_WS_URL = 'ws://localhost:18789'
const DEFAULT_SESSION_KEY = 'main'
const DEFAULT_TICK_INTERVAL_MS = 30_000
const MIN_TICK_WATCHDOG_POLL_MS = 750
const MAX_TICK_WATCHDOG_POLL_MS = 5_000
const TICK_MISS_TOLERANCE_MULTIPLIER = 2
const MAX_INLINE_ATTACHMENT_BYTES = 5_000_000
const NO_MESSAGE_SENTINEL = 'NO_MESSAGE'

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const MAX_SEEN_CHAT_EVENTS = 2048

type StoredIdentity = {
  version: 1
  deviceId: string
  publicKeyPem: string
  privateKeyPem: string
  createdAtMs: number
  deviceToken?: string
}

type DeviceIdentity = {
  deviceId: string
  publicKeyPem: string
  privateKeyPem: string
  deviceToken?: string
}

type PendingRequest = {
  method: string
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

type OutboundSendOptions = Parameters<NonNullable<ConnectorInstance['sendMessage']>>[2]

type OutboundAttachment = {
  type: 'image' | 'file'
  mimeType: string
  fileName?: string
  content: string
}

type ChatEventPayload = {
  runId?: string
  seq?: number
  state?: string
  sessionKey?: string
  message?: {
    role?: string
    sender?: string
    senderId?: string
    senderName?: string
    text?: string
    content?: unknown
  }
  sender?: string
  senderId?: string
  senderName?: string
  text?: string
}

function isSecureWsUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'wss:') return true
  if (parsed.protocol !== 'ws:') return false
  const host = parsed.hostname.trim().toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  if (host.startsWith('127.')) return true
  return false
}

function isNoMessage(text: string): boolean {
  return text.trim().toUpperCase() === NO_MESSAGE_SENTINEL
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem)
  const spki = key.export({ type: 'spki', format: 'der' }) as Buffer
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32
    && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length)
  }
  return spki
}

function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem)
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function buildDeviceAuthPayload(params: {
  deviceId: string
  clientId: string
  clientMode: string
  role: string
  scopes: string[]
  signedAtMs: number
  token?: string | null
  nonce?: string | null
}): string {
  const version = params.nonce ? 'v2' : 'v1'
  const scopes = params.scopes.join(',')
  const token = params.token ?? ''
  const base = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
  ]
  if (version === 'v2') base.push(params.nonce ?? '')
  return base.join('|')
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem)
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key)
  return base64UrlEncode(sig)
}

function resolveIdentityPath(connectorId: string): string {
  return path.join(process.cwd(), 'data', 'openclaw', `${connectorId}-device.json`)
}

function persistIdentity(filePath: string, identity: DeviceIdentity) {
  const doc: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
    deviceToken: identity.deviceToken,
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
  try { fs.chmodSync(filePath, 0o600) } catch { /* best effort */ }
}

function loadOrCreateIdentity(filePath: string): DeviceIdentity {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as StoredIdentity
      if (
        parsed?.version === 1
        && typeof parsed.deviceId === 'string'
        && typeof parsed.publicKeyPem === 'string'
        && typeof parsed.privateKeyPem === 'string'
      ) {
        const derivedDeviceId = fingerprintPublicKey(parsed.publicKeyPem)
        const identity: DeviceIdentity = {
          deviceId: derivedDeviceId || parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
          deviceToken: typeof parsed.deviceToken === 'string' && parsed.deviceToken.trim()
            ? parsed.deviceToken.trim()
            : undefined,
        }
        if (identity.deviceId !== parsed.deviceId) persistIdentity(filePath, identity)
        return identity
      }
    }
  } catch {
    // fall through and regenerate
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const identity: DeviceIdentity = {
    deviceId: fingerprintPublicKey(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
  persistIdentity(filePath, identity)
  return identity
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const obj = part as { text?: unknown; input_text?: unknown }
    if (typeof obj.text === 'string') parts.push(obj.text)
    else if (typeof obj.input_text === 'string') parts.push(obj.input_text)
  }
  return parts.join('\n').trim()
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return String(err)
}

function normalizeMimeType(value?: string | null): string | undefined {
  if (!value) return undefined
  const cleaned = value.split(';')[0]?.trim().toLowerCase()
  return cleaned || undefined
}

function inferMimeFromFileName(fileName?: string): string | undefined {
  if (!fileName) return undefined
  const ext = path.extname(fileName).toLowerCase()
  switch (ext) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.gif': return 'image/gif'
    case '.webp': return 'image/webp'
    case '.bmp': return 'image/bmp'
    case '.svg': return 'image/svg+xml'
    case '.txt': return 'text/plain'
    case '.json': return 'application/json'
    case '.pdf': return 'application/pdf'
    case '.zip': return 'application/zip'
    case '.mp3': return 'audio/mpeg'
    case '.wav': return 'audio/wav'
    case '.ogg': return 'audio/ogg'
    case '.mp4': return 'video/mp4'
    case '.mov': return 'video/quicktime'
    case '.webm': return 'video/webm'
    default: return undefined
  }
}

function parseDataUrl(value: string): { mimeType?: string; base64: string } | null {
  const match = /^data:([^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(value.trim())
  if (!match) return null
  const mimeType = normalizeMimeType(match[1])
  const base64 = match[2].replace(/\s+/g, '')
  if (!base64) return null
  return { mimeType, base64 }
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function deriveFileNameFromUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value)
    const fileName = path.basename(parsed.pathname || '')
    return fileName && fileName !== '/' ? fileName : undefined
  } catch {
    return undefined
  }
}

function buildAttachmentFromBuffer(buffer: Buffer, opts: {
  mimeType?: string
  fileName?: string
}): OutboundAttachment {
  if (buffer.byteLength > MAX_INLINE_ATTACHMENT_BYTES) {
    throw new Error(
      `OpenClaw attachment exceeds size limit (${buffer.byteLength} > ${MAX_INLINE_ATTACHMENT_BYTES} bytes)`,
    )
  }

  const fileName = opts.fileName?.trim() || undefined
  const mimeType = (
    normalizeMimeType(opts.mimeType)
    || inferMimeFromFileName(fileName)
    || 'application/octet-stream'
  )
  const type: OutboundAttachment['type'] = mimeType.startsWith('image/') ? 'image' : 'file'
  return {
    type,
    mimeType,
    fileName,
    content: buffer.toString('base64'),
  }
}

async function buildOutboundAttachments(options?: OutboundSendOptions): Promise<{
  attachments: OutboundAttachment[]
  fallbackUrl: string | null
}> {
  if (!options) return { attachments: [], fallbackUrl: null }

  // Explicit local file path gets first priority.
  if (options.mediaPath) {
    const filePath = options.mediaPath
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`)
    const content = fs.readFileSync(filePath)
    const attachment = buildAttachmentFromBuffer(content, {
      mimeType: options.mimeType,
      fileName: options.fileName || path.basename(filePath),
    })
    return { attachments: [attachment], fallbackUrl: null }
  }

  const mediaUrl = options.imageUrl || options.fileUrl
  if (!mediaUrl) return { attachments: [], fallbackUrl: null }

  // Data URL can be sent as a true attachment.
  const data = parseDataUrl(mediaUrl)
  if (data) {
    const attachment = buildAttachmentFromBuffer(Buffer.from(data.base64, 'base64'), {
      mimeType: options.mimeType || data.mimeType,
      fileName: options.fileName,
    })
    return { attachments: [attachment], fallbackUrl: null }
  }

  // For regular URLs, attempt inline fetch so OpenClaw receives real attachment bytes.
  if (isHttpUrl(mediaUrl)) {
    try {
      const response = await fetch(mediaUrl)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const arrayBuffer = await response.arrayBuffer()
      const attachment = buildAttachmentFromBuffer(Buffer.from(arrayBuffer), {
        mimeType: options.mimeType || response.headers.get('content-type') || undefined,
        fileName: options.fileName || deriveFileNameFromUrl(mediaUrl),
      })
      return { attachments: [attachment], fallbackUrl: null }
    } catch (err) {
      console.warn(`[openclaw] Failed to inline media URL, falling back to link send: ${getErrorMessage(err)}`)
      return { attachments: [], fallbackUrl: mediaUrl }
    }
  }

  return { attachments: [], fallbackUrl: null }
}

function extractInbound(payload: ChatEventPayload): InboundMessage | null {
  if (!payload || typeof payload !== 'object') return null
  if (payload.state && payload.state !== 'final') return null

  const message = payload.message || {}
  const roleRaw = typeof message.role === 'string' ? message.role.toLowerCase() : ''
  const text = (
    (typeof message.text === 'string' ? message.text : '')
    || contentToText(message.content)
    || (typeof payload.text === 'string' ? payload.text : '')
  ).trim()

  if (!text) return null
  if (roleRaw && roleRaw !== 'user') return null

  const sessionKey = (typeof payload.sessionKey === 'string' && payload.sessionKey.trim())
    ? payload.sessionKey.trim()
    : DEFAULT_SESSION_KEY

  const senderId = (
    message.senderId
    || message.sender
    || payload.senderId
    || payload.sender
    || 'unknown'
  ).toString()

  const senderName = (
    message.senderName
    || message.sender
    || payload.senderName
    || payload.sender
    || 'User'
  ).toString()

  return {
    platform: 'openclaw',
    channelId: sessionKey,
    channelName: sessionKey,
    senderId,
    senderName,
    text,
  }
}

const openclaw: PlatformConnector = {
  async start(connector, botToken, onMessage): Promise<ConnectorInstance> {
    const rawUrl = (connector.config.wsUrl || DEFAULT_WS_URL || '').trim()
    const wsUrl = rawUrl || DEFAULT_WS_URL
    if (!isSecureWsUrl(wsUrl)) {
      throw new Error(
        `Insecure OpenClaw WebSocket URL: "${wsUrl}". Use wss:// for remote hosts, or ws:// only on localhost/127.x/::1.`,
      )
    }

    const defaultSessionKey = (
      typeof connector.config.sessionKey === 'string' && connector.config.sessionKey.trim()
        ? connector.config.sessionKey.trim()
        : DEFAULT_SESSION_KEY
    )

    const clientId = 'gateway-client'
    const clientMode = 'backend'
    const clientDisplayName = (
      typeof connector.config.clientDisplayName === 'string' && connector.config.clientDisplayName.trim()
        ? connector.config.clientDisplayName.trim()
        : typeof connector.config.nodeId === 'string' && connector.config.nodeId.trim()
          ? connector.config.nodeId.trim()
          : connector.name
    )

    const rawScopes: unknown = (connector.config as Record<string, unknown>).scopes
    const configuredScopes = typeof rawScopes === 'string'
      ? rawScopes.split(',').map((s: string) => s.trim()).filter(Boolean)
      : Array.isArray(rawScopes)
        ? rawScopes.map((s: unknown) => String(s).trim()).filter(Boolean)
        : []
    const scopes = configuredScopes.length > 0 ? configuredScopes : ['operator.read', 'operator.write']
    const rawTickInterval = Number((connector.config as Record<string, unknown>).tickIntervalMs)
    const configuredTickIntervalMs = Number.isFinite(rawTickInterval) && rawTickInterval > 0
      ? Math.round(rawTickInterval)
      : null
    const rawTickWatchdog = String(
      (connector.config as Record<string, unknown>).tickWatchdog ?? 'true',
    ).trim().toLowerCase()
    const tickWatchdogEnabled = rawTickWatchdog !== 'false' && rawTickWatchdog !== '0' && rawTickWatchdog !== 'off'

    const configuredRole = typeof connector.config.role === 'string'
      ? connector.config.role.trim()
      : ''
    const role = configuredRole || 'operator'
    const identityPath = resolveIdentityPath(connector.id)
    let identity = loadOrCreateIdentity(identityPath)

    let ws: WebSocket | null = null
    let stopped = false
    let reconnectAttempt = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let connectTimer: ReturnType<typeof setTimeout> | null = null
    let connectHelloTimer: ReturnType<typeof setTimeout> | null = null
    let tickWatchdogTimer: ReturnType<typeof setInterval> | null = null
    let connectNonce: string | null = null
    let connectSent = false
    let connected = false
    let lastTickAtMs = 0
    let tickIntervalMs = configuredTickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS

    const pending = new Map<string, PendingRequest>()
    const seenInbound = new Set<string>()

    function clearPending(reason: string) {
      for (const [id, p] of pending) {
        clearTimeout(p.timer)
        p.reject(new Error(reason))
        pending.delete(id)
      }
    }

    function clearReconnectTimer() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }

    function clearConnectTimer() {
      if (connectTimer) {
        clearTimeout(connectTimer)
        connectTimer = null
      }
    }

    function clearConnectHelloTimer() {
      if (connectHelloTimer) {
        clearTimeout(connectHelloTimer)
        connectHelloTimer = null
      }
    }

    function clearTickWatchdogTimer() {
      if (tickWatchdogTimer) {
        clearInterval(tickWatchdogTimer)
        tickWatchdogTimer = null
      }
    }

    function startTickWatchdog() {
      clearTickWatchdogTimer()
      if (!tickWatchdogEnabled || tickIntervalMs <= 0) return

      const toleranceMs = Math.max(
        3_000,
        Math.round(tickIntervalMs * TICK_MISS_TOLERANCE_MULTIPLIER),
      )
      const pollMs = Math.max(
        MIN_TICK_WATCHDOG_POLL_MS,
        Math.min(MAX_TICK_WATCHDOG_POLL_MS, Math.round(toleranceMs / 3)),
      )
      lastTickAtMs = Date.now()
      tickWatchdogTimer = setInterval(() => {
        if (stopped || !connected) return
        if (!ws || ws.readyState !== WebSocket.OPEN) return
        if (lastTickAtMs <= 0) return
        const delta = Date.now() - lastTickAtMs
        if (delta <= toleranceMs) return
        console.error(
          `[openclaw] Tick missed (${delta}ms > ${toleranceMs}ms), forcing reconnect`,
        )
        try { ws.close(4000, 'tick missed') } catch { /* ignore */ }
      }, pollMs)
      // Do not keep the process alive solely for health checks.
      tickWatchdogTimer.unref?.()
    }

    function cleanupSocket() {
      clearConnectTimer()
      clearConnectHelloTimer()
      clearReconnectTimer()
      clearTickWatchdogTimer()
      clearPending('openclaw socket closed')
      if (ws) {
        try { ws.close() } catch { /* ignore */ }
        ws = null
      }
      connectSent = false
      connected = false
      connectNonce = null
      lastTickAtMs = 0
    }

    function scheduleReconnect() {
      if (stopped) return
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS)
      reconnectAttempt++
      console.log(`[openclaw] Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`)
      clearReconnectTimer()
      reconnectTimer = setTimeout(() => connect(), delay)
    }

    function sendRaw(frame: Record<string, unknown>): boolean {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false
      try {
        ws.send(JSON.stringify(frame))
        return true
      } catch {
        return false
      }
    }

    function rpcRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('openclaw not connected'))
      }
      const id = crypto.randomUUID()
      const frame = { type: 'req', id, method, params }
      if (!sendRaw(frame)) {
        return Promise.reject(new Error(`failed to send request: ${method}`))
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`openclaw rpc timeout: ${method}`))
        }, RPC_TIMEOUT_MS)
        pending.set(id, { method, resolve, reject, timer })
      })
    }

    async function sendChat(sessionKey: string, text: string, options?: OutboundSendOptions): Promise<void> {
      const key = (sessionKey || '').trim() || defaultSessionKey
      const outgoing = text.trim()
      const caption = options?.caption?.trim() || ''
      const { attachments, fallbackUrl } = await buildOutboundAttachments(options)

      let message = outgoing || caption
      if (!message && attachments.length > 0) message = 'See attached.'
      if (fallbackUrl) {
        message = message ? `${message}\n${fallbackUrl}` : fallbackUrl
      }
      if (!message && attachments.length === 0) return

      const params: Record<string, unknown> = {
        sessionKey: key,
        message,
        idempotencyKey: crypto.randomUUID(),
      }
      if (attachments.length > 0) params.attachments = attachments
      await rpcRequest('chat.send', params)
    }

    function persistIdentityToken(token?: string) {
      const normalized = typeof token === 'string' && token.trim() ? token.trim() : undefined
      if (identity.deviceToken === normalized) return
      identity = { ...identity, deviceToken: normalized }
      persistIdentity(identityPath, identity)
    }

    function clearStaleTokenIfNeeded(reason?: string) {
      const lowerReason = (reason || '').toLowerCase()
      if (!lowerReason.includes('device token mismatch')) return
      if (!identity.deviceToken) return
      console.warn('[openclaw] Clearing stale stored device token after mismatch')
      persistIdentityToken(undefined)
    }

    function sendConnect() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      if (connectSent) return
      connectSent = true
      clearConnectTimer()

      const configuredToken = (botToken || connector.config.token || '').trim()
      const authToken = configuredToken || identity.deviceToken || undefined
      const auth = authToken ? { token: authToken } : undefined
      const signedAt = Date.now()
      const nonce = connectNonce || undefined

      const payload = buildDeviceAuthPayload({
        deviceId: identity.deviceId,
        clientId,
        clientMode,
        role,
        scopes,
        signedAtMs: signedAt,
        token: authToken ?? null,
        nonce,
      })

      const connectParams = {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: clientId,
          displayName: clientDisplayName,
          version: 'swarmclaw',
          platform: process.platform,
          mode: clientMode,
          instanceId: connector.id,
        },
        role,
        scopes,
        caps: [],
        commands: [],
        permissions: {},
        auth,
        locale: 'en-US',
        userAgent: 'swarmclaw-openclaw-connector/1.0',
        device: {
          id: identity.deviceId,
          publicKey: base64UrlEncode(derivePublicKeyRaw(identity.publicKeyPem)),
          signature: signDevicePayload(identity.privateKeyPem, payload),
          signedAt,
          nonce,
        },
      }

      void rpcRequest('connect', connectParams)
        .then((hello) => {
          clearConnectHelloTimer()
          connected = true
          reconnectAttempt = 0
          const helloObj = hello && typeof hello === 'object'
            ? (hello as {
              auth?: { deviceToken?: unknown }
              policy?: { tickIntervalMs?: unknown }
            })
            : null
          const deviceToken = helloObj?.auth?.deviceToken
          if (typeof deviceToken === 'string' && deviceToken.trim()) {
            persistIdentityToken(deviceToken)
          }
          const policyTick = Number(helloObj?.policy?.tickIntervalMs)
          if (Number.isFinite(policyTick) && policyTick > 0) {
            tickIntervalMs = Math.round(policyTick)
          } else if (configuredTickIntervalMs) {
            tickIntervalMs = configuredTickIntervalMs
          } else {
            tickIntervalMs = DEFAULT_TICK_INTERVAL_MS
          }
          if (tickWatchdogEnabled) startTickWatchdog()
          console.log(`[openclaw] Connected + authenticated (${wsUrl})`)
        })
        .catch((err: unknown) => {
          clearConnectHelloTimer()
          console.error(`[openclaw] Connect handshake failed: ${getErrorMessage(err)}`)
          try { ws?.close(1008, 'connect failed') } catch { /* ignore */ }
        })
    }

    async function handleChatEvent(payload: ChatEventPayload) {
      const inbound = extractInbound(payload)
      if (!inbound) return

      // Optional session filter.
      const configuredSessionFilter = typeof connector.config.sessionKey === 'string'
        ? connector.config.sessionKey.trim()
        : ''
      if (configuredSessionFilter && inbound.channelId !== configuredSessionFilter) return

      const dedupeKey = `${payload.runId || ''}:${payload.seq || ''}:${inbound.channelId}:${inbound.text}`
      if (dedupeKey.trim()) {
        if (seenInbound.has(dedupeKey)) return
        seenInbound.add(dedupeKey)
        if (seenInbound.size > MAX_SEEN_CHAT_EVENTS) {
          const first = seenInbound.values().next().value
          if (first) seenInbound.delete(first)
        }
      }

      try {
        const response = await onMessage(inbound)
        if (!isNoMessage(response)) await sendChat(inbound.channelId, response)
      } catch (err: unknown) {
        const message = getErrorMessage(err)
        console.error('[openclaw] Error routing inbound chat event:', message)
        await sendChat(inbound.channelId, `[Error] ${message}`)
      }
    }

    function connect() {
      if (stopped) return
      cleanupSocket()
      console.log(`[openclaw] Connecting to ${wsUrl}`)
      ws = new WebSocket(wsUrl)

      ws.onopen = () => {
        console.log(`[openclaw] Socket open: ${wsUrl}`)
        connectSent = false
        connected = false
        lastTickAtMs = 0
        clearConnectHelloTimer()
        connectHelloTimer = setTimeout(() => {
          if (stopped || connected) return
          console.warn(`[openclaw] Connect handshake timed out after ${CONNECT_HELLO_TIMEOUT_MS}ms`)
          try { ws?.close(4001, 'connect timeout') } catch { /* ignore */ }
        }, CONNECT_HELLO_TIMEOUT_MS)
        connectHelloTimer.unref?.()
        connectTimer = setTimeout(() => sendConnect(), CONNECT_DELAY_FALLBACK_MS)
      }

      ws.onmessage = (event) => {
        let frame: unknown
        try {
          frame = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
        } catch {
          console.warn('[openclaw] Ignoring non-JSON frame')
          return
        }
        if (!frame || typeof frame !== 'object') return
        const frameObj = frame as {
          type?: unknown
          event?: unknown
          payload?: unknown
          id?: unknown
          ok?: unknown
          error?: { message?: unknown } | null
        }
        const frameType = typeof frameObj.type === 'string' ? frameObj.type : ''

        if (frameType === 'event') {
          const frameEvent = typeof frameObj.event === 'string' ? frameObj.event : ''
          if (frameEvent === 'connect.challenge') {
            const payload = frameObj.payload && typeof frameObj.payload === 'object'
              ? (frameObj.payload as { nonce?: unknown })
              : null
            const nonce = payload?.nonce
            if (typeof nonce === 'string' && nonce.trim()) connectNonce = nonce
            sendConnect()
            return
          }
          if (frameEvent === 'chat') {
            void handleChatEvent((frameObj.payload || {}) as ChatEventPayload)
            return
          }
          if (frameEvent === 'tick') {
            lastTickAtMs = Date.now()
            return
          }
          return
        }

        if (frameType === 'res') {
          const id = typeof frameObj.id === 'string' ? frameObj.id : ''
          if (!id) return
          const req = pending.get(id)
          if (!req) return
          pending.delete(id)
          clearTimeout(req.timer)
          if (frameObj.ok === true) req.resolve(frameObj.payload)
          else {
            const errorMessage = typeof frameObj.error?.message === 'string'
              ? frameObj.error.message
              : `${req.method} failed`
            req.reject(new Error(errorMessage))
          }
          return
        }
      }

      ws.onclose = (event) => {
        const reason = event.reason || 'none'
        console.log(`[openclaw] Disconnected (code=${event.code}, reason=${reason})`)
        clearStaleTokenIfNeeded(reason)
        cleanupSocket()
        if (!stopped) scheduleReconnect()
      }

      ws.onerror = () => {
        console.error('[openclaw] WebSocket error')
      }
    }

    connect()

    return {
      connector,
      async sendMessage(channelId, text, options) {
        if (!connected) throw new Error('openclaw connector is not connected')
        await sendChat(channelId || defaultSessionKey, text, options)
      },
      async stop() {
        stopped = true
        cleanupSocket()
        console.log('[openclaw] Connector stopped')
      },
    }
  },
}

export default openclaw
