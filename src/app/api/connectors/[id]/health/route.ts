import { NextResponse } from 'next/server'
import { notFound } from '@/lib/server/collection-helpers'
import { getConnectorHealthForApi } from '@/lib/server/connectors/connector-service'
import type { ConnectorHealthEvent } from '@/types'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const result = getConnectorHealthForApi(id)
  if (!result) return notFound()
  const url = new URL(req.url)
  const since = url.searchParams.get('since')
  const events = since ? result.events.filter((entry) => entry.timestamp >= since) : result.events
  return NextResponse.json({ events, uptimePercent: computeUptime(events) })
}

function computeUptime(events: ConnectorHealthEvent[]): number {
  if (events.length === 0) return 0
  const firstTime = new Date(events[0].timestamp).getTime()
  const now = Date.now()
  const totalMs = now - firstTime
  if (totalMs <= 0) return 100
  let uptimeMs = 0
  let lastUpAt: number | null = null
  for (const event of events) {
    const time = new Date(event.timestamp).getTime()
    if (event.event === 'started' || event.event === 'reconnected') {
      if (lastUpAt === null) lastUpAt = time
    } else if (event.event === 'stopped' || event.event === 'error' || event.event === 'disconnected') {
      if (lastUpAt !== null) {
        uptimeMs += time - lastUpAt
        lastUpAt = null
      }
    }
  }
  if (lastUpAt !== null) uptimeMs += now - lastUpAt
  return Math.round((uptimeMs / totalMs) * 10000) / 100
}
