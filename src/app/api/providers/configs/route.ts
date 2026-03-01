import { NextResponse } from 'next/server'
import { loadProviderConfigs } from '@/lib/server/storage'
export const dynamic = 'force-dynamic'


export async function GET(_req: Request) {
  const configs = loadProviderConfigs()
  return NextResponse.json(Object.values(configs))
}
