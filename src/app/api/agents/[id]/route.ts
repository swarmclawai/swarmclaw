import { NextResponse } from 'next/server'
import { loadAgents, saveAgents, loadSessions, logActivity, upsertStoredItem, upsertStoredItems } from '@/lib/server/storage'
import { normalizeProviderEndpoint } from '@/lib/openclaw/openclaw-endpoint'
import { mutateItem, notFound, type CollectionOps } from '@/lib/server/collection-helpers'
import { ensureAgentThreadSession } from '@/lib/server/agents/agent-thread-session'
import { suspendAgentReferences } from '@/lib/server/agents/agent-cascade'
import { notify } from '@/lib/server/ws-hub'
import { normalizeAgentSandboxConfig } from '@/lib/agent-sandbox-defaults'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops: CollectionOps<any> = { load: () => loadAgents({ includeTrashed: true }), save: saveAgents, topic: 'agents', table: 'agents' }

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const result = mutateItem(ops, id, (agent) => {
    Object.assign(agent, body, { updatedAt: Date.now() })
    if (Array.isArray(body.plugins) || Array.isArray(body.tools)) {
      agent.plugins = Array.isArray(body.plugins) ? body.plugins : body.tools
      delete (agent as Record<string, unknown>).tools
    }
    if (body.platformAssignScope === 'all' || body.platformAssignScope === 'self') {
      agent.platformAssignScope = body.platformAssignScope
      agent.isOrchestrator = body.platformAssignScope === 'all'
    } else if (agent.platformAssignScope === 'all' || agent.platformAssignScope === 'self') {
      agent.isOrchestrator = agent.platformAssignScope === 'all'
    }
    if (body.apiEndpoint !== undefined) {
      agent.apiEndpoint = normalizeProviderEndpoint(
        body.provider || agent.provider,
        body.apiEndpoint,
      )
    }
    if (body.sandboxConfig !== undefined) {
      agent.sandboxConfig = normalizeAgentSandboxConfig(body.sandboxConfig)
    }
    if (body.preferredGatewayTags !== undefined) {
      agent.preferredGatewayTags = Array.isArray(body.preferredGatewayTags)
        ? body.preferredGatewayTags.filter((tag: unknown): tag is string => typeof tag === 'string' && tag.trim().length > 0)
        : []
    }
    if (body.preferredGatewayUseCase !== undefined) {
      agent.preferredGatewayUseCase = typeof body.preferredGatewayUseCase === 'string' && body.preferredGatewayUseCase.trim()
        ? body.preferredGatewayUseCase.trim()
        : null
    }
    if (body.routingTargets !== undefined && Array.isArray(body.routingTargets)) {
      agent.routingTargets = body.routingTargets.map((target: Record<string, unknown>, index: number) => ({
        id: typeof target.id === 'string' && target.id.trim() ? target.id.trim() : `route-${index + 1}`,
        label: typeof target.label === 'string' ? target.label : undefined,
        role: target.role,
        provider: (typeof target.provider === 'string' && target.provider.trim() ? target.provider : agent.provider),
        model: typeof target.model === 'string' ? target.model : '',
        credentialId: target.credentialId ?? null,
        fallbackCredentialIds: Array.isArray(target.fallbackCredentialIds) ? target.fallbackCredentialIds : [],
        apiEndpoint: normalizeProviderEndpoint(
          typeof target.provider === 'string' ? target.provider : agent.provider,
          typeof target.apiEndpoint === 'string' ? target.apiEndpoint : null,
        ),
        gatewayProfileId: target.gatewayProfileId ?? null,
        preferredGatewayTags: Array.isArray(target.preferredGatewayTags)
          ? target.preferredGatewayTags.filter((tag: unknown): tag is string => typeof tag === 'string' && tag.trim().length > 0)
          : [],
        preferredGatewayUseCase: typeof target.preferredGatewayUseCase === 'string' && target.preferredGatewayUseCase.trim()
          ? target.preferredGatewayUseCase.trim()
          : null,
        priority: typeof target.priority === 'number' ? target.priority : index + 1,
      }))
    }
    delete (agent as Record<string, unknown>).isOrchestrator
    agent.isOrchestrator = agent.platformAssignScope === 'all'
    delete (agent as Record<string, unknown>).id
    agent.id = id
    return agent
  })
  if (!result) return notFound()

  if (result.threadSessionId) {
    ensureAgentThreadSession(id)
  }

  if (result.threadSessionId) {
    const sessions = loadSessions()
    const shortcut = sessions[result.threadSessionId]
    if (shortcut) {
      let changed = false
      if (shortcut.name !== result.name) {
        shortcut.name = result.name
        changed = true
      }
      if (shortcut.shortcutForAgentId !== id) {
        shortcut.shortcutForAgentId = id
        changed = true
      }
      if (changed) upsertStoredItem('sessions', shortcut.id, shortcut)
    }
  }

  logActivity({ entityType: 'agent', entityId: id, action: 'updated', actor: 'user', summary: `Agent updated: "${result.name}"` })
  return NextResponse.json(result)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // Soft delete — set trashedAt instead of removing the record
  const result = mutateItem(ops, id, (agent) => {
    agent.trashedAt = Date.now()
    return agent
  })
  if (!result) return notFound()
  logActivity({ entityType: 'agent', entityId: id, action: 'deleted', actor: 'user', summary: `Agent trashed: "${result.name}"` })

  // Detach sessions from the trashed agent
  const sessions = loadSessions()
  const detached: Array<[string, unknown]> = []
  for (const session of Object.values(sessions) as Array<Record<string, unknown>>) {
    if (!session || session.agentId !== id) continue
    session.agentId = null
    session.heartbeatEnabled = false
    detached.push([session.id as string, session])
  }
  if (detached.length > 0) {
    upsertStoredItems('sessions', detached)
  }
  const detachedSessions = detached.length

  // Cascade: suspend tasks, schedules, watch jobs, connectors, webhooks, chatrooms
  const cascade = suspendAgentReferences(id)
  if (cascade.tasks) notify('tasks')
  if (cascade.schedules) notify('schedules')
  if (cascade.connectors) notify('connectors')
  if (cascade.webhooks) notify('webhooks')
  if (cascade.chatrooms) notify('chatrooms')

  return NextResponse.json({ ok: true, detachedSessions, ...cascade })
}
