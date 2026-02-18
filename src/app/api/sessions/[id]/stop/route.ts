import { NextResponse } from 'next/server'
import { active } from '@/lib/server/storage'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (active.has(id)) {
    try { active.get(id).kill() } catch {}
    active.delete(id)
  }
  return new NextResponse('OK')
}
