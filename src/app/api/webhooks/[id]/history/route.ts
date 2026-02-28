import { NextResponse } from 'next/server'
import { loadWebhookLogs } from '@/lib/server/storage'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const allLogs = loadWebhookLogs()
  const entries = Object.values(allLogs)
    .filter((entry: any) => entry.webhookId === id)
    .sort((a: any, b: any) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, 100)

  return NextResponse.json(entries)
}
