import { NextResponse } from 'next/server'

import { notFound } from '@/lib/server/collection-helpers'
import { getOpenClawGatewayEnvironmentStatus } from '@/lib/server/gateways/gateway-topology'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; environmentId: string }> },
) {
  const { id, environmentId } = await params
  const snapshot = await getOpenClawGatewayEnvironmentStatus(id, decodeURIComponent(environmentId))
  if (!snapshot) return notFound()
  return NextResponse.json(snapshot, { status: snapshot.errors.length > 0 ? 502 : 200 })
}
