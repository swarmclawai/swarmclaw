import { NextResponse } from 'next/server'
import { hasActiveBrowser, cleanupSessionBrowser } from '@/lib/server/session-tools'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return NextResponse.json({ active: hasActiveBrowser(id) })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  cleanupSessionBrowser(id)
  return new NextResponse('OK')
}
