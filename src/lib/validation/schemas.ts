import { z } from 'zod'

export const AgentCreateSchema = z.object({
  name: z.string().min(1, 'Agent name is required'),
  provider: z.string().min(1, 'Provider is required'),
  description: z.string().optional().default(''),
  systemPrompt: z.string().optional().default(''),
  model: z.string().optional().default(''),
  credentialId: z.string().nullable().optional().default(null),
  apiEndpoint: z.string().nullable().optional().default(null),
  isOrchestrator: z.boolean().optional().default(false),
  subAgentIds: z.array(z.string()).optional().default([]),
  plugins: z.array(z.string()).optional().default([]),
  /** @deprecated Use plugins */
  tools: z.array(z.string()).optional(),
  capabilities: z.array(z.string()).optional().default([]),
  thinkingLevel: z.string().optional(),
  soul: z.string().optional(),
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
  agentIds: z.array(z.string()).default([]),
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
