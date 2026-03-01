import { WebSocket } from 'ws'
import crypto, { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { StreamChatOptions } from './index'

// --- Device Identity (Ed25519 keypair for gateway auth) ---

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length)
  }
  return spki
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return crypto.createHash('sha256').update(derivePublicKeyRaw(publicKeyPem)).digest('hex')
}

interface DeviceIdentity {
  deviceId: string
  publicKeyPem: string
  privateKeyPem: string
}

/** Resolve the openclaw CLI's state directory (~/.openclaw by default). */
function resolveCliStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim()
  if (override) return path.resolve(override.replace(/^~/, process.env.HOME || ''))
  const home = process.env.HOME || process.env.USERPROFILE || ''
  // Check new path first, then legacy
  const newDir = path.join(home, '.openclaw')
  if (fs.existsSync(newDir)) return newDir
  const legacyDir = path.join(home, '.clawdbot')
  if (fs.existsSync(legacyDir)) return legacyDir
  return newDir
}

function getSwarmClawIdentityPath(): string {
  const dataDir = path.join(process.cwd(), 'data')
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  return path.join(dataDir, 'openclaw-device.json')
}

function tryLoadIdentityFile(filePath: string): DeviceIdentity | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (parsed?.publicKeyPem && parsed?.privateKeyPem) {
      // Re-derive deviceId from public key (matches CLI behavior)
      const derivedId = fingerprintPublicKey(parsed.publicKeyPem)
      return { deviceId: derivedId, publicKeyPem: parsed.publicKeyPem, privateKeyPem: parsed.privateKeyPem }
    }
  } catch {}
  return null
}

function loadOrCreateDeviceIdentity(): DeviceIdentity {
  // 0. Check shared device token for cross-synced identity
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSharedDeviceToken } = require('../server/openclaw-sync')
    const sharedToken = getSharedDeviceToken()
    if (sharedToken) {
      // Shared token exists — the connector has already paired.
      // Still need the keypair, so continue to identity resolution below.
      // The token will be used during WS connect.
    }
  } catch { /* openclaw-sync not available */ }

  // 1. Prefer the openclaw CLI's identity — it's likely already paired with the gateway
  const cliIdentityPath = path.join(resolveCliStateDir(), 'identity', 'device.json')
  const cliIdentity = tryLoadIdentityFile(cliIdentityPath)
  if (cliIdentity) return cliIdentity

  // 2. Fall back to SwarmClaw's own identity
  const swarmClawPath = getSwarmClawIdentityPath()
  const existing = tryLoadIdentityFile(swarmClawPath)
  if (existing) return existing

  // 3. Generate a new identity
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const identity: DeviceIdentity = {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
  }
  fs.writeFileSync(swarmClawPath, JSON.stringify({ version: 1, ...identity }, null, 2) + '\n', { mode: 0o600 })
  return identity
}

/** Get the device ID that SwarmClaw would use for pairing. */
export function getDeviceId(): string {
  return loadOrCreateDeviceIdentity().deviceId
}

// --- Protocol helpers ---

function normalizeWsUrl(raw: string): string {
  let url = raw.replace(/\/+$/, '')
  if (!/^(https?|wss?):\/\//i.test(url)) url = `http://${url}`
  url = url.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:')
  return url.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')
}

/**
 * Build connect params for the OpenClaw gateway protocol.
 *
 * The gateway allows operators with a valid token to skip device identity
 * (roleCanSkipDeviceIdentity). When useDeviceAuth is true, includes an
 * Ed25519-signed device identity for gateways that require device pairing.
 */
export function buildOpenClawConnectParams(
  token: string | undefined,
  nonce: string | undefined,
  opts?: { useDeviceAuth?: boolean },
) {
  const clientId = 'gateway-client'
  const clientMode = 'backend'
  const platform = process.platform
  const role = 'operator'
  const scopes = ['operator.admin']

  const params: Record<string, unknown> = {
    minProtocol: 3,
    maxProtocol: 3,
    auth: token ? { token } : undefined,
    client: {
      id: clientId,
      version: '1.0.0',
      platform,
      mode: clientMode,
      instanceId: randomUUID(),
    },
    caps: [],
    role,
    scopes,
  }

  if (opts?.useDeviceAuth) {
    const identity = loadOrCreateDeviceIdentity()
    const signedAtMs = Date.now()

    const payload = [
      'v3', identity.deviceId, clientId, clientMode, role,
      scopes.join(','), String(signedAtMs), token ?? '', nonce ?? '',
      platform, '', // deviceFamily
    ].join('|')
    const signature = base64UrlEncode(
      crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(identity.privateKeyPem)),
    )

    params.device = {
      id: identity.deviceId,
      publicKey: base64UrlEncode(derivePublicKeyRaw(identity.publicKeyPem)),
      signature,
      signedAt: signedAtMs,
      nonce: nonce ?? '',
    }
  }

  return params
}

// --- Gateway connection ---

export interface ConnectResult {
  ok: boolean
  message: string
  errorCode?: string
  ws?: InstanceType<typeof WebSocket>
}

/**
 * Open a WebSocket and complete the connect handshake.
 * Resolves with { ok, ws } on success or { ok: false, message, errorCode } on failure.
 */
export function wsConnect(
  wsUrl: string,
  token: string | undefined,
  useDeviceAuth: boolean,
  timeoutMs = 15_000,
): Promise<ConnectResult> {
  return new Promise((resolve) => {
    let settled = false
    const done = (result: ConnectResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!result.ok) try { ws.close() } catch {}
      resolve(result)
    }

    const timer = setTimeout(() => {
      done({ ok: false, message: 'Connection timed out. Verify the gateway URL and network access.' })
    }, timeoutMs)

    const ws = new WebSocket(wsUrl)
    let connectId: string | null = null

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.event === 'connect.challenge') {
          connectId = randomUUID()
          ws.send(JSON.stringify({
            type: 'req',
            id: connectId,
            method: 'connect',
            params: buildOpenClawConnectParams(token, msg.payload?.nonce, { useDeviceAuth }),
          }))
          return
        }
        if (msg.type === 'res' && msg.id === connectId) {
          if (msg.ok) {
            done({ ok: true, message: 'Connected.', ws })
          } else {
            const message = msg.error?.message || 'Gateway connect failed.'
            let errorCode = (msg.error?.details?.code ?? msg.error?.code) as string | undefined
            if (!errorCode) {
              const m = message.toLowerCase()
              if (m.includes('pairing') || m.includes('not paired') || m.includes('pending approval')) errorCode = 'PAIRING_REQUIRED'
              else if (m.includes('signature') || m.includes('device auth')) errorCode = 'DEVICE_AUTH_INVALID'
              else if (m.includes('token missing') || m.includes('token required')) errorCode = 'AUTH_TOKEN_MISSING'
              else if (m.includes('unauthorized') || m.includes('invalid token')) errorCode = 'AUTH_TOKEN_INVALID'
            }
            done({ ok: false, message, errorCode })
          }
        }
      } catch {
        done({ ok: false, message: 'Unexpected response from gateway.' })
      }
    })

    ws.on('error', (err) => {
      done({ ok: false, message: `Connection failed: ${err.message}` })
    })

    ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || ''
      if (code === 1008) {
        const m = reasonStr.toLowerCase()
        let errorCode: string | undefined
        if (m.includes('pairing') || m.includes('not paired') || m.includes('pending approval')) errorCode = 'PAIRING_REQUIRED'
        else if (m.includes('signature') || m.includes('device auth') || m.includes('device identity') || m.includes('device nonce')) errorCode = 'DEVICE_AUTH_INVALID'
        else if (m.includes('token missing') || m.includes('token required')) errorCode = 'AUTH_TOKEN_MISSING'
        else if (m.includes('unauthorized') || m.includes('invalid token')) errorCode = 'AUTH_TOKEN_INVALID'
        done({ ok: false, message: reasonStr || 'Unauthorized', errorCode })
      } else {
        done({ ok: false, message: `Connection closed unexpectedly (${code})` })
      }
    })
  })
}

/**
 * Connect to the gateway with device identity.
 *
 * Always includes Ed25519 device auth — the gateway may accept the initial
 * connect handshake with token-only but still require device identity for
 * agent operations. Sending device auth unconditionally avoids that mismatch.
 */
async function connectToGateway(
  wsUrl: string,
  token: string | undefined,
  timeoutMs = 15_000,
): Promise<ConnectResult> {
  return wsConnect(wsUrl, token, true, timeoutMs)
}

// --- Provider ---

export function streamOpenClawChat({ session, message, imagePath, apiKey, write, active }: StreamChatOptions): Promise<string> {
  let prompt = message
  if (imagePath) {
    prompt = `[The user has shared an image at: ${imagePath}]\n\n${message}`
  }

  const wsUrl = session.apiEndpoint ? normalizeWsUrl(session.apiEndpoint) : 'ws://127.0.0.1:18789'
  const token = apiKey || session.apiKey || undefined

  return new Promise((resolve) => {
    let fullResponse = ''
    let settled = false

    const finish = (errMsg?: string) => {
      if (settled) return
      settled = true
      active.delete(session.id)
      if (errMsg && !fullResponse.trim()) {
        write(`data: ${JSON.stringify({ t: 'err', text: errMsg })}\n\n`)
      }
      resolve(fullResponse)
    }

    connectToGateway(wsUrl, token).then((result) => {
      if (!result.ok || !result.ws) {
        finish(result.message)
        return
      }

      const ws = result.ws
      const timeout = setTimeout(() => {
        ws.close()
        finish('OpenClaw gateway timed out after 120s.')
      }, 120_000)

      active.set(session.id, { kill: () => { ws.close(); clearTimeout(timeout); finish('Aborted.') } })

      const agentReqId = randomUUID()
      ws.send(JSON.stringify({
        type: 'req',
        id: agentReqId,
        method: 'agent',
        params: {
          message: prompt,
          agentId: 'main',
          timeout: 120,
          idempotencyKey: randomUUID(),
        },
      }))

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'res' && msg.id === agentReqId) {
            if (!msg.ok) {
              ws.close()
              clearTimeout(timeout)
              finish(msg.error?.message || 'Agent request failed.')
              return
            }
            if (msg.payload?.status === 'accepted') return

            const payloads = msg.payload?.result?.payloads ?? []
            for (const p of payloads) {
              const text = typeof p.text === 'string' ? p.text.trimEnd() : ''
              if (text) {
                fullResponse += text
                write(`data: ${JSON.stringify({ t: 'd', text })}\n\n`)
              }
            }
            if (!fullResponse && msg.payload?.summary) {
              const text = String(msg.payload.summary)
              fullResponse = text
              write(`data: ${JSON.stringify({ t: 'd', text })}\n\n`)
            }
            ws.close()
            clearTimeout(timeout)
            finish()
          }
        } catch {}
      })

      ws.on('error', (err) => {
        clearTimeout(timeout)
        finish(`OpenClaw connection failed: ${err.message}`)
      })

      ws.on('close', (code, reason) => {
        clearTimeout(timeout)
        if (code === 1008) {
          finish(`Unauthorized: ${reason?.toString() || 'invalid token'}`)
        } else {
          finish()
        }
      })
    }).catch((err) => {
      finish(`OpenClaw error: ${err?.message || 'unknown error'}`)
    })
  })
}
