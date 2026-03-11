import crypto from 'node:crypto'

const NOVNC_TOKEN_TTL_MS = 60_000
const NOVNC_PASSWORD_LENGTH = 8
const NOVNC_PASSWORD_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

type NoVncObserverTokenEntry = {
  noVncPort: number
  password?: string
  expiresAt: number
}

export type NoVncObserverTokenPayload = {
  noVncPort: number
  password?: string
}

const noVncObserverTokens = new Map<string, NoVncObserverTokenEntry>()

function pruneExpiredObserverTokens(now: number): void {
  for (const [token, entry] of noVncObserverTokens) {
    if (entry.expiresAt <= now) noVncObserverTokens.delete(token)
  }
}

export function isNoVncEnabled(params: { enableNoVnc: boolean; headless: boolean }): boolean {
  return params.enableNoVnc && !params.headless
}

export function generateNoVncPassword(): string {
  let output = ''
  for (let index = 0; index < NOVNC_PASSWORD_LENGTH; index += 1) {
    output += NOVNC_PASSWORD_ALPHABET[crypto.randomInt(0, NOVNC_PASSWORD_ALPHABET.length)]
  }
  return output
}

export function buildNoVncDirectUrl(port: number): string {
  return `http://127.0.0.1:${port}/vnc.html`
}

export function issueNoVncObserverToken(params: {
  noVncPort: number
  password?: string
  ttlMs?: number
  nowMs?: number
}): string {
  const now = params.nowMs ?? Date.now()
  pruneExpiredObserverTokens(now)
  const token = crypto.randomBytes(24).toString('hex')
  noVncObserverTokens.set(token, {
    noVncPort: params.noVncPort,
    password: params.password?.trim() || undefined,
    expiresAt: now + Math.max(1, params.ttlMs ?? NOVNC_TOKEN_TTL_MS),
  })
  return token
}

export function consumeNoVncObserverToken(token: string, nowMs?: number): NoVncObserverTokenPayload | null {
  const now = nowMs ?? Date.now()
  pruneExpiredObserverTokens(now)
  const normalized = token.trim()
  if (!normalized) return null
  const entry = noVncObserverTokens.get(normalized)
  if (!entry) return null
  noVncObserverTokens.delete(normalized)
  if (entry.expiresAt <= now) return null
  return {
    noVncPort: entry.noVncPort,
    password: entry.password,
  }
}

export function buildNoVncObserverTokenUrl(baseUrl: string, token: string): string {
  const query = new URLSearchParams({ token })
  return `${baseUrl}/sandbox/novnc?${query.toString()}`
}
