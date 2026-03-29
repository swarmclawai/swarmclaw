import { z } from 'zod'
import type { ProtocolStepDefinition } from '@/types'
import { validateStepDag, validateStepRefs } from '@/lib/server/protocols/step-dag-validation'

const OllamaModeSchema = z.enum(['local', 'cloud']).nullable().optional().default(null)

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

const AgentExecuteConfigSchema = z.object({
  backend: z.enum(['sandbox', 'host']).optional(),
  network: z.object({
    enabled: z.boolean(),
    allowedUrls: z.array(z.string()).optional(),
  }).optional(),
  runtimes: z.object({
    python: z.boolean().optional(),
    javascript: z.boolean().optional(),
    sqlite: z.boolean().optional(),
  }).optional(),
  timeout: z.number().int().positive().optional(),
  credentials: z.array(z.string()).optional(),
}).nullable().optional()

const AgentRoutingTargetSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  role: z.enum(['primary', 'economy', 'premium', 'reasoning', 'backup']).optional(),
  provider: z.string().min(1),
  model: z.string().optional().default(''),
  ollamaMode: OllamaModeSchema,
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
  ollamaMode: OllamaModeSchema,
  credentialId: z.string().nullable().optional().default(null),
  fallbackCredentialIds: z.array(z.string()).optional().default([]),
  apiEndpoint: z.string().nullable().optional().default(null),
  gatewayProfileId: z.string().nullable().optional().default(null),
  preferredGatewayTags: z.array(z.string()).optional().default([]),
  preferredGatewayUseCase: z.string().nullable().optional().default(null),
  routingStrategy: z.enum(['single', 'balanced', 'economy', 'premium', 'reasoning']).nullable().optional().default(null),
  routingTargets: z.array(AgentRoutingTargetSchema).optional().default([]),
  delegationEnabled: z.boolean().optional().default(false),
  delegationTargetMode: z.enum(['all', 'selected']).optional().default('all'),
  delegationTargetAgentIds: z.array(z.string()).optional().default([]),
  tools: z.array(z.string()).optional(),
  extensions: z.array(z.string()).optional().default([]),
  skills: z.array(z.string()).optional().default([]),
  skillIds: z.array(z.string()).optional().default([]),
  mcpServerIds: z.array(z.string()).optional().default([]),
  mcpDisabledTools: z.array(z.string()).optional().default([]),
  capabilities: z.array(z.string()).optional().default([]),
  thinkingLevel: z.string().optional(),
  soul: z.string().optional(),
  identityState: z.record(z.string(), z.unknown()).nullable().optional().default(null),
  disabled: z.boolean().optional().default(false),
  heartbeatEnabled: z.boolean().optional().default(true),
  heartbeatInterval: z.union([z.string(), z.number()]).nullable().optional().default(null),
  heartbeatIntervalSec: z.number().int().nonnegative().nullable().optional().default(null),
  heartbeatModel: z.string().nullable().optional().default(null),
  heartbeatPrompt: z.string().nullable().optional().default(null),
  orchestratorEnabled: z.boolean().optional().default(false),
  orchestratorMission: z.string().optional().default(''),
  orchestratorWakeInterval: z.union([z.string(), z.number()]).nullable().optional().default(null),
  orchestratorGovernance: z.enum(['autonomous', 'approval-required', 'notify-only']).optional().default('autonomous'),
  orchestratorMaxCyclesPerDay: z.number().int().positive().nullable().optional().default(null),
  elevenLabsVoiceId: z.string().nullable().optional().default(null),
  sessionResetMode: z.enum(['idle', 'daily', 'isolated']).nullable().optional().default(null),
  sessionIdleTimeoutSec: z.number().int().nonnegative().nullable().optional().default(null),
  sessionMaxAgeSec: z.number().int().nonnegative().nullable().optional().default(null),
  sessionDailyResetAt: z.string().nullable().optional().default(null),
  sessionResetTimezone: z.string().nullable().optional().default(null),
  memoryScopeMode: z.enum(['auto', 'all', 'global', 'agent', 'session', 'project']).nullable().optional().default(null),
  memoryTierPreference: z.enum(['working', 'durable', 'archive', 'blended']).nullable().optional().default(null),
  proactiveMemory: z.boolean().optional().default(true),
  autoDraftSkillSuggestions: z.boolean().optional().default(true),
  projectId: z.string().optional(),
  avatarSeed: z.string().optional(),
  avatarUrl: z.string().nullable().optional().default(null),
  sandboxConfig: AgentSandboxConfigSchema,
  executeConfig: AgentExecuteConfigSchema,
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
    'bluebubbles', 'signal', 'teams', 'googlechat', 'matrix', 'email', 'swarmdock',
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
  routingGuidance: z.string().nullable().optional(),
  routingRules: z.array(z.object({
    id: z.string(),
    type: z.enum(['keyword', 'capability']),
    pattern: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    agentId: z.string(),
    priority: z.number(),
  })).optional(),
})

export const ProtocolPhaseDefinitionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    'present',
    'collect_independent_inputs',
    'round_robin',
    'compare',
    'decide',
    'summarize',
    'emit_tasks',
    'wait',
  ]),
  label: z.string().min(1),
  instructions: z.string().nullable().optional().default(null),
  turnLimit: z.number().int().positive().nullable().optional().default(null),
  completionCriteria: z.string().nullable().optional().default(null),
})

export const ProtocolConditionDefinitionSchema: z.ZodType<
  | { type: 'summary_exists' }
  | { type: 'artifact_exists'; artifactKind?: string | null }
  | { type: 'artifact_count_at_least'; count: number; artifactKind?: string | null }
  | { type: 'created_task_count_at_least'; count: number }
  | { type: 'all'; conditions: unknown[] }
  | { type: 'any'; conditions: unknown[] }
> = z.lazy(() => z.union([
  z.object({ type: z.literal('summary_exists') }),
  z.object({
    type: z.literal('artifact_exists'),
    artifactKind: z.enum(['summary', 'decision', 'comparison', 'notes', 'action_items']).nullable().optional().default(null),
  }),
  z.object({
    type: z.literal('artifact_count_at_least'),
    count: z.number().int().nonnegative(),
    artifactKind: z.enum(['summary', 'decision', 'comparison', 'notes', 'action_items']).nullable().optional().default(null),
  }),
  z.object({
    type: z.literal('created_task_count_at_least'),
    count: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('all'),
    conditions: z.array(ProtocolConditionDefinitionSchema).min(1),
  }),
  z.object({
    type: z.literal('any'),
    conditions: z.array(ProtocolConditionDefinitionSchema).min(1),
  }),
]))

export const ProtocolBranchCaseSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  nextStepId: z.string().min(1),
  description: z.string().nullable().optional().default(null),
  when: ProtocolConditionDefinitionSchema.nullable().optional().default(null),
})

export const ProtocolRepeatConfigSchema = z.object({
  bodyStepId: z.string().min(1),
  nextStepId: z.string().nullable().optional().default(null),
  maxIterations: z.number().int().positive(),
  exitCondition: ProtocolConditionDefinitionSchema.nullable().optional().default(null),
  onExhausted: z.enum(['advance', 'fail']).optional().default('fail'),
})

const ProtocolForEachItemsSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('literal'), items: z.array(z.unknown()).min(1) }),
  z.object({ type: z.literal('step_output'), stepId: z.string().min(1), path: z.string().nullable().optional().default(null) }),
  z.object({ type: z.literal('artifact'), artifactId: z.string().nullable().optional().default(null), artifactKind: z.string().nullable().optional().default(null) }),
  z.object({ type: z.literal('llm_extract'), prompt: z.string().min(1) }),
])

const ProtocolForEachConfigSchema = z.object({
  itemsSource: ProtocolForEachItemsSourceSchema,
  itemAlias: z.string().min(1),
  branchTemplate: z.object({
    steps: z.lazy(() => z.array(ProtocolStepDefinitionSchema).min(1)),
    entryStepId: z.string().nullable().optional().default(null),
    participantAgentIds: z.array(z.string()).optional().default([]),
    facilitatorAgentId: z.string().nullable().optional().default(null),
  }),
  joinMode: z.literal('all').optional().default('all'),
  maxItems: z.number().int().min(1).max(200).nullable().optional().default(50),
  onEmpty: z.enum(['fail', 'skip', 'advance']).optional().default('fail'),
})

const ProtocolSubflowConfigSchema = z.object({
  templateId: z.string().min(1),
  templateVersion: z.string().nullable().optional().default(null),
  participantAgentIds: z.array(z.string()).optional().default([]),
  facilitatorAgentId: z.string().nullable().optional().default(null),
  inputMapping: z.record(z.string(), z.string()).nullable().optional().default(null),
  outputMapping: z.record(z.string(), z.string()).nullable().optional().default(null),
  onFailure: z.enum(['fail_parent', 'advance_with_warning']).optional().default('fail_parent'),
})

const ProtocolSwarmWorkItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().nullable().optional().default(null),
})

const ProtocolSwarmWorkItemsSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('literal'), items: z.array(ProtocolSwarmWorkItemSchema).min(1) }),
  z.object({ type: z.literal('step_output'), stepId: z.string().min(1), path: z.string().nullable().optional().default(null) }),
])

const ProtocolSwarmConfigSchema = z.object({
  eligibleAgentIds: z.array(z.string().min(1)).min(1),
  workItemsSource: ProtocolSwarmWorkItemsSourceSchema,
  claimLimitPerAgent: z.number().int().min(1).max(10).nullable().optional().default(1),
  selectionMode: z.enum(['first_claim', 'claim_until_empty']).optional().default('first_claim'),
  claimTimeoutSec: z.number().min(30).max(3600).optional().default(300),
  onUnclaimed: z.enum(['fail', 'advance', 'fallback_assign']).optional().default('fail'),
})

export const ProtocolJoinConfigSchema = z.object({
  parallelStepId: z.string().nullable().optional().default(null),
})

export const ProtocolParallelBranchDefinitionSchema: z.ZodTypeAny = z.lazy(() => z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  steps: z.array(ProtocolStepDefinitionSchema).min(1),
  entryStepId: z.string().nullable().optional().default(null),
  participantAgentIds: z.array(z.string()).optional().default([]),
  facilitatorAgentId: z.string().nullable().optional().default(null),
  observerAgentIds: z.array(z.string()).optional().default([]),
}))

export const ProtocolParallelConfigSchema = z.object({
  branches: z.array(ProtocolParallelBranchDefinitionSchema).min(1),
})

export const ProtocolStepDefinitionSchema: z.ZodTypeAny = z.lazy(() => z.object({
  id: z.string().min(1),
  kind: z.enum([
    'present',
    'collect_independent_inputs',
    'round_robin',
    'compare',
    'decide',
    'summarize',
    'emit_tasks',
    'wait',
    'branch',
    'repeat',
    'parallel',
    'join',
    'complete',
    'for_each',
    'subflow',
    'swarm_claim',
    'dispatch_task',
    'dispatch_delegation',
  ]),
  label: z.string().min(1),
  instructions: z.string().nullable().optional().default(null),
  turnLimit: z.number().int().positive().nullable().optional().default(null),
  completionCriteria: z.string().nullable().optional().default(null),
  nextStepId: z.string().nullable().optional().default(null),
  branchCases: z.array(ProtocolBranchCaseSchema).optional().default([]),
  defaultNextStepId: z.string().nullable().optional().default(null),
  repeat: ProtocolRepeatConfigSchema.nullable().optional().default(null),
  parallel: ProtocolParallelConfigSchema.nullable().optional().default(null),
  join: ProtocolJoinConfigSchema.nullable().optional().default(null),
  dependsOnStepIds: z.array(z.string()).optional().default([]),
  outputKey: z.string().nullable().optional().default(null),
  forEach: ProtocolForEachConfigSchema.nullable().optional().default(null),
  subflow: ProtocolSubflowConfigSchema.nullable().optional().default(null),
  swarm: ProtocolSwarmConfigSchema.nullable().optional().default(null),
}))

export const ProtocolRunCreateSchema = z.object({
  title: z.string().min(1, 'A session title is required'),
  templateId: z.string().min(1).optional().default('facilitated_discussion'),
  participantAgentIds: z.array(z.string()).min(1, 'Select at least one participant').default([]),
  facilitatorAgentId: z.string().nullable().optional().default(null),
  observerAgentIds: z.array(z.string()).optional().default([]),
  taskId: z.string().nullable().optional().default(null),
  sessionId: z.string().nullable().optional().default(null),
  parentChatroomId: z.string().nullable().optional().default(null),
  scheduleId: z.string().nullable().optional().default(null),
  autoStart: z.boolean().optional().default(true),
  createTranscript: z.boolean().optional().default(true),
  config: z.object({
    goal: z.string().nullable().optional().default(null),
    kickoffMessage: z.string().nullable().optional().default(null),
    roundLimit: z.number().int().positive().nullable().optional().default(null),
    decisionMode: z.string().nullable().optional().default(null),
    autoEmitTasks: z.boolean().optional().default(false),
    taskProjectId: z.string().nullable().optional().default(null),
    postSummaryToParent: z.boolean().optional().default(true),
  }).optional().default({
    goal: null,
    kickoffMessage: null,
    roundLimit: null,
    decisionMode: null,
    autoEmitTasks: false,
    taskProjectId: null,
    postSummaryToParent: true,
  }),
  phases: z.array(ProtocolPhaseDefinitionSchema).optional(),
  steps: z.array(ProtocolStepDefinitionSchema).optional(),
  entryStepId: z.string().nullable().optional().default(null),
})

export const ProtocolTemplateUpsertSchema = z.object({
  name: z.string().min(1, 'A template name is required'),
  description: z.string().min(1, 'A template description is required'),
  singleAgentAllowed: z.boolean().optional().default(true),
  tags: z.array(z.string().min(1)).optional().default([]),
  recommendedOutputs: z.array(z.string().min(1)).optional().default([]),
  defaultPhases: z.array(ProtocolPhaseDefinitionSchema).optional().default([]),
  steps: z.array(ProtocolStepDefinitionSchema).optional().default([]),
  entryStepId: z.string().nullable().optional().default(null),
}).superRefine((value, ctx) => {
  if (value.defaultPhases.length === 0 && value.steps.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['steps'],
      message: 'Provide at least one phase or one step.',
    })
  }
  if (value.steps.length > 0) {
    const steps = value.steps as ProtocolStepDefinition[]
    const dagResult = validateStepDag(steps)
    if (!dagResult.valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps'],
        message: `Cycle detected in step dependencies: ${dagResult.cycle?.join(' → ')}`,
      })
    }
    const invalidRefs = validateStepRefs(steps)
    for (const ref of invalidRefs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['steps'],
        message: `Step references unknown step ID: "${ref}"`,
      })
    }
  }
})

export const ProtocolRunActionSchema = z.object({
  action: z.enum(['start', 'pause', 'resume', 'retry_phase', 'skip_phase', 'cancel', 'archive', 'inject_context', 'claim_work']),
  reason: z.string().nullable().optional().default(null),
  phaseId: z.string().nullable().optional().default(null),
  context: z.string().nullable().optional().default(null),
  stepId: z.string().nullable().optional().default(null),
  agentId: z.string().nullable().optional().default(null),
  workItemId: z.string().nullable().optional().default(null),
})

const PortableAgentSchema = z.object({
  originalId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  systemPrompt: z.string(),
  provider: z.string().min(1),
  model: z.string().min(1),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  skillIds: z.array(z.string()).optional(),
}).passthrough()

const PortableSkillSchema = z.object({
  originalId: z.string().min(1),
  name: z.string().min(1),
  content: z.string(),
}).passthrough()

const PortableScheduleSchema = z.object({
  originalId: z.string().min(1),
  originalAgentId: z.string().min(1),
  name: z.string().min(1),
}).passthrough()

export const PortableManifestSchema = z.object({
  formatVersion: z.number().int().nonnegative(),
  exportedAt: z.string().optional(),
  agents: z.array(PortableAgentSchema),
  skills: z.array(PortableSkillSchema),
  schedules: z.array(PortableScheduleSchema),
})

/** Format ZodError into a 400-friendly payload */
export function formatZodError(err: z.ZodError) {
  return { error: 'Validation failed', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }
}
