import { NextResponse } from 'next/server'
import { loadConnectors } from '@/lib/server/storage'

export const dynamic = 'force-dynamic'

function readSecret(req: Request): string {
  const url = new URL(req.url)
  return (
    req.headers.get('x-connector-secret')
    || url.searchParams.get('secret')
    || ''
  ).trim()
}

function parseWebhookBody(rawBody: string): Record<string, unknown> {
  const trimmed = rawBody.trim()
  if (!trimmed) return {}

  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return { data: parsed }
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    // Fall back to URL-encoded payloads used by some webhook providers.
    const params = new URLSearchParams(rawBody)
    const nested = params.get('payload') || params.get('data') || params.get('message') || ''
    if (nested) {
      try {
        const parsedNested = JSON.parse(nested)
        if (Array.isArray(parsedNested)) return { data: parsedNested }
        return parsedNested && typeof parsedNested === 'object'
          ? parsedNested as Record<string, unknown>
          : {}
      } catch {
        // Ignore malformed nested JSON and return flat map below.
      }
    }
    const out: Record<string, unknown> = {}
    for (const [key, value] of params.entries()) out[key] = value
    return out
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const connectors = loadConnectors()
  const connector = connectors[id]
  if (!connector) return NextResponse.json({ error: 'Connector not found' }, { status: 404 })

  const requiredSecret = String(connector.config?.webhookSecret || '').trim()
  if (requiredSecret && readSecret(req) !== requiredSecret) {
    return NextResponse.json({ error: 'Invalid connector webhook secret' }, { status: 401 })
  }

  const rawBody = await req.text().catch(() => '')
  const payload = parseWebhookBody(rawBody)

  try {
    if (connector.platform === 'teams') {
      const handlerKey = `__swarmclaw_teams_handler_${connector.id}__`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic globalThis handler registered at runtime by connector
      const handler = (globalThis as any)[handlerKey]
      if (typeof handler !== 'function') {
        return NextResponse.json({ error: 'Teams connector is not running or not ready' }, { status: 409 })
      }
      await handler(payload)
      return NextResponse.json({ ok: true })
    }

    if (connector.platform === 'googlechat') {
      const handlerKey = `__swarmclaw_googlechat_handler_${connector.id}__`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic globalThis handler registered at runtime by connector
      const handler = (globalThis as any)[handlerKey]
      if (typeof handler !== 'function') {
        return NextResponse.json({ error: 'Google Chat connector is not running or not ready' }, { status: 409 })
      }
      const result = await handler(payload)
      if (result && typeof result === 'object' && Object.keys(result).length > 0) {
        return NextResponse.json(result)
      }
      return NextResponse.json({})
    }

    if (connector.platform === 'bluebubbles') {
      const handlerKey = `__swarmclaw_bluebubbles_handler_${connector.id}__`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic globalThis handler registered at runtime by connector
      const handler = (globalThis as any)[handlerKey]
      if (typeof handler !== 'function') {
        return NextResponse.json({ error: 'BlueBubbles connector is not running or not ready' }, { status: 409 })
      }
      const result = await handler(payload)
      if (result && typeof result === 'object' && Object.keys(result).length > 0) {
        return NextResponse.json(result)
      }
      return NextResponse.json({})
    }

    return NextResponse.json({ error: `Platform "${connector.platform}" does not support connector webhook ingress.` }, { status: 400 })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Webhook processing failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
