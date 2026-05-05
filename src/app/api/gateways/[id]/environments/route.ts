import { NextResponse } from 'next/server'

import { notFound } from '@/lib/server/collection-helpers'
import { listOpenClawGatewayEnvironments } from '@/lib/server/gateways/gateway-topology'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const snapshot = await listOpenClawGatewayEnvironments(id)
  if (!snapshot) return notFound()
  return NextResponse.json(snapshot)
}
