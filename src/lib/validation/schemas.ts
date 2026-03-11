import { z } from 'zod'

const AgentSandboxBrowserSchema = z.object({
  enabled: z.boolean().optional(),
  image: z.string().optional(),
  containerPrefix: z.string().optional(),
  network: z.enum(['none', 'bridge']).optional(),
  cdpPort: z.number().int().positive().optional(),
  vncPort: z.number().int().positive().optional(),
  noVncPort: z.number().int().positive().optional(),
  headless: z.boolean().optional(),
  enableNoVnc: z.boolean().optional(),
  mountUploads: z.boolean().optional(),
  autoStartTimeoutMs: z.number().int().positive().optional(),
}).nullable().optional()

const AgentSandboxPruneSchema = z.object({
  idleHours: z.number().positive().optional(),
  maxAgeDays: z.number().positive().optional(),
}).nullable().optional()

const AgentSandboxConfigSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['off', 'non-main', 'all']).optional(),
  scope: z.enum(['session', 'agent']).optional(),
  workspaceAccess: z.enum(['ro', 'rw']).optional(),
  image: z.string().optional(),
  network: z.enum(['none', 'bridge']).optional(),
  memoryMb: z.number().int().positive().optional(),
  cpus: z.number().positive().optional(),
  readonlyRoot: z.boolean().optional(),
  workdir: z.string().optional(),
  containerPrefix: z.string().optional(),
  pidsLimit: z.number().int().positive().optional(),
  setupCommand: z.string().optional(),
  browser: AgentSandboxBrowserSchema,
  prune: AgentSandboxPruneSchema,
}).nullable().optional()

const AgentRoutingTargetSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  role: z.enum(['primary', 'economy', 'premium', 'reasoning', 'backup']).optional(),
  provider: z.string().min(1),
  model: z.string().optional().default(''),
  credentialId: z.string().nullable().optional().default(null),
  fallbackCredentialIds: z.array(z.string()).optional().default([]),
  apiEndpoint: z.string().nullable().optional().default(null),
  gatewayProfileId: z.string().nullable().optional().default(null),
  preferredGatewayTags: z.array(z.string()).optional().default([]),
  preferredGatewayUseCase: z.string().nullable().optional().default(null),
  priority: z.number().int().optional(),
})

export const AgentCreateSchema = z.object({
  name: z.string().min(1, 'Agent name is required'),
  provider: z.string().min(1, 'Provider is required'),
  description: z.string().optional().default(''),
  systemPrompt: z.string().optional().default(''),
  model: z.string().optional().default(''),
  credentialId: z.string().nullable().optional().default(null),
  fallbackCredentialIds: z.array(z.string()).optional().default([]),
  apiEndpoint: z.string().nullable().optional().default(null),
  gatewayProfileId: z.string().nullable().optional().default(null),
  preferredGatewayTags: z.array(z.string()).optional().default([]),
  preferredGatewayUseCase: z.string().nullable().optional().default(null),
  routingStrategy: z.enum(['single', 'balanced', 'economy', 'premium', 'reasoning']).nullable().optional().default(null),
  routingTargets: z.array(AgentRoutingTargetSchema).optional().default([]),
  isOrchestrator: z.boolean().optional().default(false),
  platformAssignScope: z.enum(['self', 'all']).optional().default('all'),
  subAgentIds: z.array(z.string()).optional().default([]),
  plugins: z.array(z.string()).optional().default([]),
  /** @deprecated Use plugins */
  tools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional().default([]),
  skillIds: z.array(z.string()).optional().default([]),
  mcpServerIds: z.array(z.string()).optional().default([]),
  mcpDisabledTools: z.array(z.string()).optional().default([]),
  capabilities: z.array(z.string()).optional().default([]),
  thinkingLevel: z.string().optional(),
  soul: z.string().optional(),
  identityState: z.record(z.string(), z.unknown()).nullable().optional().default(null),
  disabled: z.boolean().optional().default(false),
  heartbeatEnabled: z.boolean().optional().default(false),
  heartbeatInterval: z.union([z.string(), z.number()]).nullable().optional().default(null),
  heartbeatIntervalSec: z.number().int().nonnegative().nullable().optional().default(null),
  heartbeatModel: z.string().nullable().optional().default(null),
  heartbeatPrompt: z.string().nullable().optional().default(null),
  elevenLabsVoiceId: z.string().nullable().optional().default(null),
  sessionResetMode: z.enum(['idle', 'daily']).nullable().optional().default(null),
  sessionIdleTimeoutSec: z.number().int().nonnegative().nullable().optional().default(null),
  sessionMaxAgeSec: z.number().int().nonnegative().nullable().optional().default(null),
  sessionDailyResetAt: z.string().nullable().optional().default(null),
  sessionResetTimezone: z.string().nullable().optional().default(null),
  memoryScopeMode: z.enum(['auto', 'all', 'global', 'agent', 'session', 'project']).nullable().optional().default(null),
  memoryTierPreference: z.enum(['working', 'durable', 'archive', 'blended']).nullable().optional().default(null),
  projectId: z.string().optional(),
  avatarSeed: z.string().optional(),
  avatarUrl: z.string().nullable().optional().default(null),
  sandboxConfig: AgentSandboxConfigSchema,
  autoRecovery: z.boolean().optional().default(false),
  monthlyBudget: z.number().positive().nullable().optional().default(null),
  dailyBudget: z.number().positive().nullable().optional().default(null),
  hourlyBudget: z.number().positive().nullable().optional().default(null),
  budgetAction: z.enum(['warn', 'block']).optional().default('warn'),
})

export const ConnectorCreateSchema = z.object({
  name: z.string().min(1, 'Connector name is required').optional(),
  platform: z.enum([
    'discord', 'telegram', 'slack', 'whatsapp', 'openclaw',
    'bluebubbles', 'signal', 'teams', 'googlechat', 'matrix', 'email',
  ]),
  agentId: z.string().nullable().optional().default(null),
  chatroomId: z.string().nullable().optional().default(null),
  credentialId: z.string().nullable().optional().default(null),
  config: z.record(z.string(), z.string()).optional().default({}),
  autoStart: z.boolean().optional(),
})

export const ExternalAgentRegisterSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, 'External agent name is required'),
  sourceType: z.enum(['codex', 'claude', 'opencode', 'openclaw', 'custom']).default('custom'),
  status: z.enum(['online', 'idle', 'offline', 'stale']).optional().default('online'),
  provider: z.string().nullable().optional().default(null),
  model: z.string().nullable().optional().default(null),
  workspace: z.string().nullable().optional().default(null),
  transport: z.enum(['http', 'ws', 'cli', 'gateway', 'custom']).nullable().optional().default(null),
  endpoint: z.string().nullable().optional().default(null),
  agentId: z.string().nullable().optional().default(null),
  gatewayProfileId: z.string().nullable().optional().default(null),
  capabilities: z.array(z.string()).optional().default([]),
  labels: z.array(z.string()).optional().default([]),
  lifecycleState: z.enum(['active', 'draining', 'cordoned']).optional().default('active'),
  gatewayTags: z.array(z.string()).optional().default([]),
  gatewayUseCase: z.string().nullable().optional().default(null),
  version: z.string().nullable().optional().default(null),
  lastHealthNote: z.string().nullable().optional().default(null),
  metadata: z.record(z.string(), z.unknown()).nullable().optional().default(null),
  tokenStats: z.object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    totalTokens: z.number().nonnegative().optional(),
  }).nullable().optional().default(null),
})

export const TaskCreateSchema = z.object({
  title: z.string().min(1, 'Task title is required'),
  description: z.string().optional().default(''),
  status: z.string().optional(),
  agentId: z.string().optional().default(''),
  projectId: z.string().nullable().optional(),
  goalContract: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  file: z.string().nullable().optional(),
  blockedBy: z.array(z.string()).optional(),
  blocks: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  maxAttempts: z.number().optional(),
  retryBackoffSec: z.number().optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  dueAt: z.number().nullable().optional(),
  qualityGate: z.object({
    enabled: z.boolean().optional(),
    minResultChars: z.number().optional(),
    minEvidenceItems: z.number().optional(),
    requireVerification: z.boolean().optional(),
    requireArtifact: z.boolean().optional(),
    requireReport: z.boolean().optional(),
  }).nullable().optional(),
})

export const ChatroomCreateSchema = z.object({
  name: z.string().min(1, 'Chatroom name is required'),
  agentIds: z.array(z.string()).min(1, 'Select at least one agent').default([]),
  description: z.string().optional().default(''),
  chatMode: z.enum(['sequential', 'parallel']).optional(),
  autoAddress: z.boolean().optional(),
  routingRules: z.array(z.object({
    id: z.string(),
    type: z.enum(['keyword', 'capability']),
    pattern: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    agentId: z.string(),
    priority: z.number(),
  })).optional(),
})

/** Format ZodError into a 400-friendly payload */
export function formatZodError(err: z.ZodError) {
  return { error: 'Validation failed', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }
}
