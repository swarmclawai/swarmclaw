import { NextResponse } from 'next/server'
import { localIP } from '@/lib/server/storage'
export const dynamic = 'force-dynamic'


export async function GET(_req: Request) {
  return NextResponse.json({ ip: localIP(), port: parseInt(process.env.PORT || '3000') })
}
