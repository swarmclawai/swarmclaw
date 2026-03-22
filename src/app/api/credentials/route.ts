import { NextResponse } from 'next/server'
import { createCredentialRecord, listCredentialSummaries } from '@/lib/server/credentials/credential-service'
import { safeParseBody } from '@/lib/server/safe-parse-body'
export const dynamic = 'force-dynamic'


export async function GET() {
  return NextResponse.json(listCredentialSummaries())
}

export async function POST(req: Request) {
  const { data: body, error } = await safeParseBody<{ provider: string; name: string; apiKey: string }>(req)
  if (error) return error
  const { provider, name, apiKey } = body
  if (!provider || !apiKey) {
    return NextResponse.json({ error: 'provider and apiKey are required' }, { status: 400 })
  }
  try {
    return NextResponse.json(createCredentialRecord({ provider, name, apiKey }))
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create credential' },
      { status: 500 },
    )
  }
}
