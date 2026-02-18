import { NextResponse } from 'next/server'
import { localIP } from '@/lib/server/storage'

export async function GET() {
  return NextResponse.json({ ip: localIP(), port: parseInt(process.env.PORT || '3000') })
}
