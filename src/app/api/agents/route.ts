import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { perf } from '@/lib/server/runtime/perf'
import { loadAgents, loadSessions, loadUsage, logActivity, upsertStoredItem } from '@/lib/server/storage'
import { normalizeProviderEndpoint } from '@/lib/openclaw/openclaw-endpoint'
import { notify } from '@/lib/server/ws-hub'
import { getAgentSpendWindows } from '@/lib/server/cost'
import { resolveAgentPluginSelection } from '@/lib/agent-default-tools'
import { normalizeAgentSandboxConfig } from '@/lib/agent-sandbox-defaults'
import { AgentCreateSchema, formatZodError } from '@/lib/validation/schemas'
import { z } from 'zod'
export const dynamic = 'force-dynamic'

async function ensureDaemonIfNeeded(source: string) {
  const { ensureDaemonStarted } = await import('@/lib/server/runtime/daemon-state')
  ensureDaemonStarted(source)
}


export async function GET(req: Request) {
  const endPerf = perf.start('api', 'GET /api/agents')
  const agents = loadAgents()
  const sessions = loadSessions()
  const usage = loadUsage()
  for (const agent of Object.values(agents)) {
    agent.isOrchestrator = agent.platformAssignScope === 'all'
  }
  // Enrich agents that have spend limits with current spend windows
  for (const agent of Object.values(agents)) {
    if (
      (typeof agent.monthlyBudget === 'number' && agent.monthlyBudget > 0)
      || (typeof agent.dailyBudget === 'number' && agent.dailyBudget > 0)
      || (typeof agent.hourlyBudget === 'number' && agent.hourlyBudget > 0)
    ) {
      const spend = getAgentSpendWindows(agent.id, Date.now(), { sessions, usage })
      if (typeof agent.monthlyBudget === 'number' && agent.monthlyBudget > 0) agent.monthlySpend = spend.monthly
      if (typeof agent.dailyBudget === 'number' && agent.dailyBudget > 0) agent.dailySpend = spend.daily
      if (typeof agent.hourlyBudget === 'number' && agent.hourlyBudget > 0) agent.hourlySpend = spend.hourly
    }
  }

  const { searchParams } = new URL(req.url)
  const limitParam = searchParams.get('limit')
  if (!limitParam) {
    endPerf({ count: Object.keys(agents).length })
    return NextResponse.json(agents)
  }

  const limit = Math.max(1, Number(limitParam) || 50)
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0)
  const all = Object.values(agents).sort((a, b) => b.updatedAt - a.updatedAt)
  const items = all.slice(offset, offset + limit)
  endPerf({ count: items.length, total: all.length })
  return NextResponse.json({ items, total: all.length, hasMore: offset + limit < all.length })
}

export async function POST(req: Request) {
  await ensureDaemonIfNeeded('api/agents:post')
  const raw = await req.json()
  const rawRecord = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  const parsed = AgentCreateSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
  }
  const body = parsed.data
  const plugins = resolveAgentPluginSelection({
    hasExplicitPlugins: Boolean(rawRecord && Object.prototype.hasOwnProperty.call(rawRecord, 'plugins')),
    hasExplicitTools: Boolean(rawRecord && Object.prototype.hasOwnProperty.call(rawRecord, 'tools')),
    plugins: body.plugins,
    tools: body.tools,
  })
  const id = genId()
  const now = Date.now()
  const platformAssignScope = body.platformAssignScope
  const agent = {
    id,
    name: body.name,
    description: body.description,
    soul: body.soul || undefined,
    systemPrompt: body.systemPrompt,
    provider: body.provider,
    model: body.model,
    credentialId: body.credentialId,
    fallbackCredentialIds: body.fallbackCredentialIds,
    apiEndpoint: normalizeProviderEndpoint(body.provider, body.apiEndpoint || null),
    gatewayProfileId: body.gatewayProfileId,
    preferredGatewayTags: body.preferredGatewayTags,
    preferredGatewayUseCase: body.preferredGatewayUseCase,
    routingStrategy: body.routingStrategy,
    routingTargets: body.routingTargets?.map((target) => ({
      ...target,
      apiEndpoint: normalizeProviderEndpoint(target.provider, target.apiEndpoint || null),
    })),
    isOrchestrator: platformAssignScope === 'all',
    platformAssignScope,
    subAgentIds: body.subAgentIds,
    plugins,
    skills: body.skills,
    skillIds: body.skillIds,
    mcpServerIds: body.mcpServerIds,
    mcpDisabledTools: body.mcpDisabledTools?.length ? body.mcpDisabledTools : undefined,
    capabilities: body.capabilities,
    thinkingLevel: body.thinkingLevel || undefined,
    autoRecovery: body.autoRecovery || false,
    disabled: body.disabled || false,
    heartbeatEnabled: body.heartbeatEnabled || false,
    heartbeatInterval: body.heartbeatInterval,
    heartbeatIntervalSec: body.heartbeatIntervalSec,
    heartbeatModel: body.heartbeatModel,
    heartbeatPrompt: body.heartbeatPrompt,
    elevenLabsVoiceId: body.elevenLabsVoiceId,
    monthlyBudget: body.monthlyBudget ?? null,
    dailyBudget: body.dailyBudget ?? null,
    hourlyBudget: body.hourlyBudget ?? null,
    budgetAction: body.budgetAction || 'warn',
    identityState: body.identityState ?? null,
    memoryScopeMode: body.memoryScopeMode,
    memoryTierPreference: body.memoryTierPreference,
    projectId: body.projectId,
    avatarSeed: body.avatarSeed,
    avatarUrl: body.avatarUrl,
    sessionResetMode: body.sessionResetMode ?? null,
    sessionIdleTimeoutSec: body.sessionIdleTimeoutSec ?? null,
    sessionMaxAgeSec: body.sessionMaxAgeSec ?? null,
    sessionDailyResetAt: body.sessionDailyResetAt ?? null,
    sessionResetTimezone: body.sessionResetTimezone ?? null,
    sandboxConfig: normalizeAgentSandboxConfig(body.sandboxConfig),
    createdAt: now,
    updatedAt: now,
  }
  upsertStoredItem('agents', id, agent)
  logActivity({ entityType: 'agent', entityId: id, action: 'created', actor: 'user', summary: `Agent created: "${agent.name}"` })
  notify('agents')
  return NextResponse.json(agent)
}
