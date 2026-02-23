export interface GatewayRequestFrame {
  type: 'req'
  id: string
  method: string
  params?: Record<string, unknown>
}

export interface GatewayResponseFrame {
  type: 'res'
  id: string
  ok: boolean
  payload?: unknown
  error?: {
    code?: string
    message?: string
  } | null
}

export interface GatewayEventFrame {
  type: 'event'
  event: string
  payload?: unknown
}

export type GatewayFrame = GatewayRequestFrame | GatewayResponseFrame | GatewayEventFrame

function toJsonString(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString('utf8')
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  if (raw && typeof raw === 'object' && 'toString' in raw) {
    try {
      return String((raw as { toString: () => string }).toString())
    } catch {
      return null
    }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseFrameObject(value: unknown): GatewayFrame | null {
  if (!isRecord(value)) return null
  const type = typeof value.type === 'string' ? value.type : ''
  if (type === 'req') {
    const id = typeof value.id === 'string' ? value.id : ''
    const method = typeof value.method === 'string' ? value.method : ''
    if (!id || !method) return null
    const params = isRecord(value.params) ? value.params : undefined
    return { type: 'req', id, method, params }
  }
  if (type === 'res') {
    const id = typeof value.id === 'string' ? value.id : ''
    const ok = value.ok === true
    if (!id) return null
    const error = isRecord(value.error)
      ? {
          code: typeof value.error.code === 'string' ? value.error.code : undefined,
          message: typeof value.error.message === 'string' ? value.error.message : undefined,
        }
      : null
    return {
      type: 'res',
      id,
      ok,
      payload: value.payload,
      error,
    }
  }
  if (type === 'event') {
    const event = typeof value.event === 'string' ? value.event : ''
    if (!event) return null
    return {
      type: 'event',
      event,
      payload: value.payload,
    }
  }
  return null
}

export function parseGatewayFrame(raw: unknown): GatewayFrame | null {
  if (isRecord(raw) && typeof raw.type === 'string') {
    return parseFrameObject(raw)
  }
  const text = toJsonString(raw)
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    return parseFrameObject(parsed)
  } catch {
    return null
  }
}

export function serializeGatewayFrame(frame: GatewayFrame): string {
  return JSON.stringify(frame)
}

export function createGatewayRequestFrame(
  id: string,
  method: string,
  params?: Record<string, unknown>,
): GatewayRequestFrame {
  return {
    type: 'req',
    id,
    method,
    params,
  }
}
