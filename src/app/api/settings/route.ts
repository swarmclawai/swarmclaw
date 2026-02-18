import { NextResponse } from 'next/server'
import { loadSettings, saveSettings } from '@/lib/server/storage'

export async function GET() {
  return NextResponse.json(loadSettings())
}

export async function PUT(req: Request) {
  const body = await req.json()
  const settings = loadSettings()
  Object.assign(settings, body)
  saveSettings(settings)
  return NextResponse.json(settings)
}
