import { NextResponse } from 'next/server'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { notFound } from '@/lib/server/collection-helpers'
import {
  deleteConnectorFromRoute,
  getConnectorWithRuntime,
  updateConnectorFromRoute,
} from '@/lib/server/connectors/connector-service'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const connector = await getConnectorWithRuntime(id)
  if (!connector) return notFound()
  return NextResponse.json(connector)
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: body, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error
  const result = await updateConnectorFromRoute(id, body)
  if (!result.ok && result.status === 404) return notFound()
  return result.ok
    ? NextResponse.json(result.payload)
    : NextResponse.json(result.payload, { status: result.status })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const result = await deleteConnectorFromRoute(id)
  if (!result.ok) return notFound()
  return NextResponse.json(result.payload)
}
