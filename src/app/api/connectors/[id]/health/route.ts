import { NextResponse } from 'next/server'
import { loadConnectors, loadConnectorHealth } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import type { ConnectorHealthEvent } from '@/types'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const connectors = loadConnectors()
  if (!connectors[id]) return notFound()

  const url = new URL(req.url)
  const since = url.searchParams.get('since')

  const allHealth = loadConnectorHealth()
  const events: ConnectorHealthEvent[] = []

  for (const raw of Object.values(allHealth)) {
    const entry = raw as ConnectorHealthEvent
    if (entry.connectorId !== id) continue
    if (since && entry.timestamp < since) continue
    events.push(entry)
  }

  // Sort by timestamp ascending
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  // Compute uptime percentage
  const uptimePercent = computeUptime(events)

  return NextResponse.json({ events, uptimePercent })
}

function computeUptime(events: ConnectorHealthEvent[]): number {
  if (events.length === 0) return 0

  const firstTime = new Date(events[0].timestamp).getTime()
  const now = Date.now()
  const totalMs = now - firstTime
  if (totalMs <= 0) return 100

  let uptimeMs = 0
  let lastUpAt: number | null = null

  for (const ev of events) {
    const t = new Date(ev.timestamp).getTime()
    if (ev.event === 'started' || ev.event === 'reconnected') {
      if (lastUpAt === null) {
        lastUpAt = t
      }
    } else if (ev.event === 'stopped' || ev.event === 'error' || ev.event === 'disconnected') {
      if (lastUpAt !== null) {
        uptimeMs += t - lastUpAt
        lastUpAt = null
      }
    }
  }

  // If still up, count time until now
  if (lastUpAt !== null) {
    uptimeMs += now - lastUpAt
  }

  return Math.round((uptimeMs / totalMs) * 10000) / 100
}
