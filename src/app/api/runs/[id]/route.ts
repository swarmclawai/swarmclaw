import { NextResponse } from 'next/server'
import { getRunById } from '@/lib/server/runtime/session-run-manager'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const run = getRunById(id)
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  return NextResponse.json(run)
}
