import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { formatZodError, ExternalAgentRegisterSchema } from '@/lib/validation/schemas'
import { loadExternalAgents, loadGatewayProfiles, saveExternalAgents } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import type { ExternalAgentRuntime } from '@/types'
import { z } from 'zod'
export const dynamic = 'force-dynamic'

function withDerivedStatus(record: ExternalAgentRuntime): ExternalAgentRuntime {
  const now = Date.now()
  const lastSeenAt = typeof record.lastSeenAt === 'number' ? record.lastSeenAt : null
  const staleMs = 3 * 60_000
  if (!lastSeenAt) return { ...record, status: record.status || 'offline' }
  if (record.status === 'offline') return record
  const gateways = loadGatewayProfiles()
  const gateway = record.gatewayProfileId ? gateways[record.gatewayProfileId] as any : undefined
  const gatewayTags = Array.isArray(gateway?.tags)
    ? (gateway as any)?.tags?.filter((tag: any): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : []
  const gatewayUseCase = gateway?.deployment && typeof gateway.deployment === 'object' && typeof (gateway.deployment as Record<string, unknown>).useCase === 'string'
    ? (gateway.deployment as Record<string, unknown>).useCase as string
    : null
  return {
    ...record,
    status: now - lastSeenAt > staleMs ? 'stale' : (record.status || 'online'),
    lifecycleState: record.lifecycleState || 'active',
    gatewayTags: record.gatewayTags?.length ? record.gatewayTags : gatewayTags,
    gatewayUseCase: record.gatewayUseCase || gatewayUseCase,
  }
}

export async function GET() {
  const runtimes = loadExternalAgents()
  const items: ExternalAgentRuntime[] = Object.values(runtimes)
    .map((item) => withDerivedStatus(item))
    .sort((a, b) => (b.lastSeenAt || b.updatedAt || 0) - (a.lastSeenAt || a.updatedAt || 0))
  return NextResponse.json(items)
}

export async function POST(req: Request) {
  const raw = await req.json().catch(() => ({}))
  const parsed = ExternalAgentRegisterSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
  }
  const body = parsed.data
  const now = Date.now()
  const items = loadExternalAgents()
  const id = body.id || `external-${genId()}`
  const existing = items[id]
  items[id] = {
    ...existing,
    id,
    name: body.name.trim(),
    sourceType: body.sourceType,
    status: body.status || existing?.status || 'online',
    provider: (body.provider as ExternalAgentRuntime['provider']) || null,
    model: body.model || null,
    workspace: body.workspace || null,
    transport: body.transport || null,
    endpoint: body.endpoint || null,
    agentId: body.agentId || null,
    gatewayProfileId: body.gatewayProfileId || null,
    capabilities: body.capabilities,
    labels: body.labels,
    lifecycleState: body.lifecycleState || existing?.lifecycleState || 'active',
    gatewayTags: body.gatewayTags,
    gatewayUseCase: body.gatewayUseCase || null,
    version: body.version || null,
    lastHealthNote: body.lastHealthNote || null,
    metadata: body.metadata,
    tokenStats: body.tokenStats,
    lastHeartbeatAt: existing?.lastHeartbeatAt || now,
    lastSeenAt: now,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }
  saveExternalAgents(items)
  notify('external_agents')
  return NextResponse.json(items[id])
}
