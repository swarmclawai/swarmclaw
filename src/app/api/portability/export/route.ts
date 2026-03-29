import { NextResponse } from 'next/server'
import { exportConfig } from '@/lib/server/portability/export'
export const dynamic = 'force-dynamic'

export async function GET() {
  const manifest = exportConfig()
  return NextResponse.json(manifest)
}
