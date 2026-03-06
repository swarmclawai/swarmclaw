import { NextResponse } from 'next/server'
import { discoverProviderModels } from '@/lib/server/provider-model-discovery'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const { searchParams } = new URL(req.url)
  const result = await discoverProviderModels({
    providerId: id,
    credentialId: searchParams.get('credentialId'),
    endpoint: searchParams.get('endpoint'),
    force: searchParams.get('force') === '1',
    requiresApiKey: searchParams.has('requiresApiKey')
      ? searchParams.get('requiresApiKey') !== '0'
      : undefined,
  })

  return NextResponse.json(result, {
    headers: {
      'Cache-Control': 'private, no-store',
    },
  })
}
