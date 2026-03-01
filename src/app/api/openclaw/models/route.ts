import { NextResponse } from 'next/server'
import { fetchGatewayModelPolicy, buildAllowedModelKeys } from '@/lib/server/openclaw-models'

/** GET — fetch allowed models for OpenClaw agents from gateway policy */
export async function GET() {
  const policy = await fetchGatewayModelPolicy()
  const models = buildAllowedModelKeys(policy)
  return NextResponse.json({
    models: models ?? ['default'],
    defaultModel: policy?.defaultModel ?? 'default',
  })
}
