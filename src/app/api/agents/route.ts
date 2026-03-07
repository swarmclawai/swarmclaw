import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadAgents, loadSessions, loadUsage, saveAgents, logActivity } from '@/lib/server/storage'
import { normalizeProviderEndpoint } from '@/lib/openclaw-endpoint'
import { notify } from '@/lib/server/ws-hub'
import { getAgentSpendWindows } from '@/lib/server/cost'
import { AgentCreateSchema, formatZodError } from '@/lib/validation/schemas'
import { z } from 'zod'
export const dynamic = 'force-dynamic'


export async function GET(req: Request) {
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
  if (!limitParam) return NextResponse.json(agents)

  const limit = Math.max(1, Number(limitParam) || 50)
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0)
  const all = Object.values(agents).sort((a, b) => b.updatedAt - a.updatedAt)
  const items = all.slice(offset, offset + limit)
  return NextResponse.json({ items, total: all.length, hasMore: offset + limit < all.length })
}

export async function POST(req: Request) {
  const raw = await req.json()
  const parsed = AgentCreateSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(formatZodError(parsed.error as z.ZodError), { status: 400 })
  }
  const body = parsed.data
  const id = genId()
  const now = Date.now()
  const agents = loadAgents()
  const platformAssignScope = body.platformAssignScope
  agents[id] = {
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
    plugins: body.plugins?.length ? body.plugins : (body.tools || []),
    skills: body.skills,
    skillIds: body.skillIds,
    mcpServerIds: body.mcpServerIds,
    mcpDisabledTools: body.mcpDisabledTools?.length ? body.mcpDisabledTools : undefined,
    capabilities: body.capabilities,
    thinkingLevel: body.thinkingLevel || undefined,
    autoRecovery: body.autoRecovery || false,
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
    createdAt: now,
    updatedAt: now,
  }
  saveAgents(agents)
  logActivity({ entityType: 'agent', entityId: id, action: 'created', actor: 'user', summary: `Agent created: "${agents[id].name}"` })
  notify('agents')
  return NextResponse.json(agents[id])
}
