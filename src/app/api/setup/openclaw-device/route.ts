import { NextResponse } from 'next/server'
import { getDeviceId } from '@/lib/providers/openclaw'

export async function GET() {
  try {
    const deviceId = getDeviceId()
    return NextResponse.json({ deviceId })
  } catch (err: any) {
    return NextResponse.json({ deviceId: null, error: err?.message }, { status: 500 })
  }
}
