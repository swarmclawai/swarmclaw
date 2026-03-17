import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import os from 'os'
import path from 'path'
import { perf } from '@/lib/server/runtime/perf'
import { loadAgents } from '@/lib/server/storage'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { notify } from '@/lib/server/ws-hub'
import { deleteSession, listSessions, replaceSessions } from '@/lib/server/sessions/session-repository'
import { stopActiveSessionProcess } from '@/lib/server/runtime/runtime-state'
import { getSessionQueueSnapshot, getSessionRunState } from '@/lib/server/runtime/session-run-manager'
import { normalizeProviderEndpoint } from '@/lib/openclaw/openclaw-endpoint'
import { applyResolvedRoute, resolvePrimaryAgentRoute } from '@/lib/server/agents/agent-runtime-config'
import { buildAgentDisabledMessage, isAgentDisabled } from '@/lib/server/agents/agent-availability'
import { buildSessionListSummary } from '@/lib/chat/session-summary'
import { normalizeCapabilitySelection } from '@/lib/capability-selection'
import { enrichSessionWithMissionSummary } from '@/lib/server/missions/mission-service'
export const dynamic = 'force-dynamic'

async function ensureDaemonIfNeeded(source: string) {
  const { ensureDaemonStarted } = await import('@/lib/server/runtime/daemon-state')
  ensureDaemonStarted(source)
}


export async function GET(req: Request) {
  const endPerf = perf.start('api', 'GET /api/chats')
  // Note: pruneThreadConnectorMirrors and materializeStreamingAssistantArtifacts
  // are handled by the daemon periodic health check, not on every list fetch.
  const sessions = listSessions()
  for (const id of Object.keys(sessions)) {
    const run = getSessionRunState(id)
    const queue = getSessionQueueSnapshot(id)
    sessions[id].active = !!run.runningRunId
    sessions[id].queuedCount = queue.queueLength
    sessions[id].currentRunId = run.runningRunId || null
  }

  const summarized = Object.fromEntries(
    Object.entries(sessions).map(([id, session]) => [id, buildSessionListSummary(enrichSessionWithMissionSummary(session))]),
  )

  const { searchParams } = new URL(req.url)
  const limitParam = searchParams.get('limit')
  if (!limitParam) {
    endPerf({ count: Object.keys(summarized).length })
    return NextResponse.json(summarized)
  }

  const limit = Math.max(1, Number(limitParam) || 50)
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0)
  const all = Object.values(summarized).sort((a, b) => (b.lastActiveAt ?? b.createdAt) - (a.lastActiveAt ?? a.createdAt))
  const items = all.slice(offset, offset + limit)
  endPerf({ count: items.length, total: all.length })
  return NextResponse.json({ items, total: all.length, hasMore: offset + limit < all.length })
}

export async function DELETE(req: Request) {
  await ensureDaemonIfNeeded('api/chats:delete')
  const { ids } = await req.json().catch(() => ({ ids: [] })) as { ids: string[] }
  if (!Array.isArray(ids) || !ids.length) {
    return new NextResponse('Missing ids', { status: 400 })
  }
  const sessions = listSessions()
  let deleted = 0
  for (const id of ids) {
    if (!sessions[id]) continue
    stopActiveSessionProcess(id)
    deleteSession(id)
    deleted += 1
  }
  notify('sessions')
  return NextResponse.json({ deleted, requested: ids.length })
}

export async function POST(req: Request) {
  await ensureDaemonIfNeeded('api/chats:post')
  const body = await req.json().catch(() => ({}))
  let cwd = (body.cwd || '').trim()
  if (cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(2))
  else if (cwd === '~') cwd = os.homedir()
  else if (!cwd) cwd = WORKSPACE_DIR

  const id = body.id || genId()
  const sessions = listSessions()
  const agent = body.agentId ? loadAgents()[body.agentId] : null
  if (isAgentDisabled(agent)) {
    return NextResponse.json({ error: buildAgentDisabledMessage(agent, 'start chats') }, { status: 409 })
  }
  const routePreferredGatewayTags = Array.isArray(body.routePreferredGatewayTags)
    ? body.routePreferredGatewayTags.filter((tag: unknown): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : []
  const routePreferredGatewayUseCase = typeof body.routePreferredGatewayUseCase === 'string' && body.routePreferredGatewayUseCase.trim()
    ? body.routePreferredGatewayUseCase.trim()
    : null
  const resolvedRoute = agent ? resolvePrimaryAgentRoute(agent, undefined, {
    preferredGatewayTags: routePreferredGatewayTags,
    preferredGatewayUseCase: routePreferredGatewayUseCase,
  }) : null
  const resolvedCapabilities = normalizeCapabilitySelection({
    tools: Array.isArray(body.tools) ? body.tools : agent?.tools,
    extensions: Array.isArray(body.extensions) ? body.extensions : agent?.extensions,
  })

  // If session with this ID already exists, return it as-is
  if (body.id && sessions[id]) {
    return NextResponse.json(sessions[id])
  }

  const sessionName = body.name || 'New Chat'

  const nextSession = {
    id, name: sessionName, cwd,
    user: body.user || 'user',
    provider: body.provider || agent?.provider || 'claude-cli',
    model: body.model || agent?.model || '',
    ollamaMode: body.ollamaMode ?? agent?.ollamaMode ?? ((body.provider || agent?.provider) === 'ollama' ? 'local' : null),
    credentialId: body.credentialId || agent?.credentialId || null,
    fallbackCredentialIds: body.fallbackCredentialIds || agent?.fallbackCredentialIds || [],
    apiEndpoint: normalizeProviderEndpoint(
      body.provider || agent?.provider || 'claude-cli',
      body.apiEndpoint || agent?.apiEndpoint || null,
    ),
    routePreferredGatewayTags,
    routePreferredGatewayUseCase,
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    delegateResumeIds: {
      claudeCode: null,
      codex: null,
      opencode: null,
      gemini: null,
    },
    messages: Array.isArray(body.messages) ? body.messages : [],
    createdAt: Date.now(), lastActiveAt: Date.now(),
    sessionType: body.sessionType || 'human',
    agentId: body.agentId || null,
    parentSessionId: body.parentSessionId || null,
    tools: resolvedCapabilities.tools,
    extensions: resolvedCapabilities.extensions,
    heartbeatEnabled: body.heartbeatEnabled ?? null,
    heartbeatIntervalSec: body.heartbeatIntervalSec ?? null,
    sessionResetMode: body.sessionResetMode ?? agent?.sessionResetMode ?? null,
    sessionIdleTimeoutSec: body.sessionIdleTimeoutSec ?? agent?.sessionIdleTimeoutSec ?? null,
    sessionMaxAgeSec: body.sessionMaxAgeSec ?? agent?.sessionMaxAgeSec ?? null,
    sessionDailyResetAt: body.sessionDailyResetAt ?? agent?.sessionDailyResetAt ?? null,
    sessionResetTimezone: body.sessionResetTimezone ?? agent?.sessionResetTimezone ?? null,
    thinkingLevel: body.thinkingLevel ?? null,
    connectorThinkLevel: body.connectorThinkLevel ?? null,
    connectorSessionScope: body.connectorSessionScope ?? null,
    connectorReplyMode: body.connectorReplyMode ?? null,
    connectorThreadBinding: body.connectorThreadBinding ?? null,
    connectorGroupPolicy: body.connectorGroupPolicy ?? null,
    connectorIdleTimeoutSec: body.connectorIdleTimeoutSec ?? null,
    connectorMaxAgeSec: body.connectorMaxAgeSec ?? null,
    connectorContext: body.connectorContext ?? null,
    identityState: body.identityState ?? agent?.identityState ?? null,
    sessionArchiveState: body.sessionArchiveState ?? null,
  }
  sessions[id] = (body.provider || body.model || body.credentialId || body.apiEndpoint)
    ? nextSession
    : applyResolvedRoute(nextSession, resolvedRoute)
  replaceSessions(sessions)
  notify('sessions')
  return NextResponse.json(sessions[id])
}
