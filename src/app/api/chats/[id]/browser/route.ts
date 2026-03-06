import { NextResponse } from 'next/server'
import { hasActiveBrowser, cleanupSessionBrowser } from '@/lib/server/session-tools'
import { loadBrowserSessionRecord } from '@/lib/server/browser-state'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return NextResponse.json({
    active: hasActiveBrowser(id),
    state: loadBrowserSessionRecord(id),
  })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  cleanupSessionBrowser(id)
  return new NextResponse('OK')
}
