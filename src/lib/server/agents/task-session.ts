import { genId } from '@/lib/id'
import { loadSessions, saveSessions } from '@/lib/server/storage'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import type { Agent } from '@/types'
import { getEnabledCapabilitySelection } from '@/lib/capability-selection'
import { applyResolvedRoute, resolvePrimaryAgentRoute } from '@/lib/server/agents/agent-runtime-config'

export function createAgentTaskSession(
  agent: Agent,
  task: string,
  parentSessionId?: string,
  cwd?: string,
  routePreferences?: {
    preferredGatewayTags?: string[]
    preferredGatewayUseCase?: string | null
  } | null,
): string {
  const sessions = loadSessions()
  const sessionId = genId()
  const preferredGatewayTags = Array.isArray(routePreferences?.preferredGatewayTags)
    ? routePreferences.preferredGatewayTags.filter((tag) => typeof tag === 'string' && tag.trim())
    : []
  const resolvedRoute = resolvePrimaryAgentRoute(agent, undefined, {
    preferredGatewayTags,
    preferredGatewayUseCase: routePreferences?.preferredGatewayUseCase || null,
  })

  sessions[sessionId] = applyResolvedRoute({
    id: sessionId,
    name: `[Task] ${agent.name}: ${task.slice(0, 40)}`,
    cwd: cwd || WORKSPACE_DIR,
    user: 'system',
    provider: agent.provider,
    model: agent.model,
    credentialId: agent.credentialId || null,
    fallbackCredentialIds: agent.fallbackCredentialIds || [],
    apiEndpoint: agent.apiEndpoint || null,
    gatewayProfileId: agent.gatewayProfileId || null,
    routePreferredGatewayTags: preferredGatewayTags,
    routePreferredGatewayUseCase: routePreferences?.preferredGatewayUseCase || null,
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    delegateResumeIds: {
      claudeCode: null,
      codex: null,
      opencode: null,
      gemini: null,
    },
    messages: [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    sessionType: 'human',
    agentId: agent.id,
    parentSessionId: parentSessionId || null,
    ...getEnabledCapabilitySelection(agent),
    heartbeatEnabled: false,
  }, resolvedRoute)

  saveSessions(sessions)
  return sessionId
}
