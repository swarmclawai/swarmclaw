import { NextResponse } from 'next/server'
import { loadProviderConfigs } from '@/lib/server/storage'

export async function GET() {
  const configs = loadProviderConfigs()
  return NextResponse.json(Object.values(configs))
}
