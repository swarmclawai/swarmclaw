import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'swarmclaw',
    time: Date.now(),
  })
}
