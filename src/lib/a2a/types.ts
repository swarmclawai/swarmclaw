import { z } from 'zod'

// --- A2A Agent Card ---
// Ref: https://a2a-protocol.org/v0.3.0/specification/#agent-card

export const AgentCardCapabilitySchema = z.object({
  name: z.string(),
  methods: z.array(z.string()).optional(),
  description: z.string().optional(),
})

export const AgentCardSkillSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  returns: z.record(z.string(), z.unknown()).optional(),
})

export const AgentCardSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string(),
  protocolVersion: z.string().default('0.3.0'),
  apiEndpoint: z.string().url(),
  capabilities: z.array(AgentCardCapabilitySchema).default([]),
  skills: z.array(AgentCardSkillSchema).default([]),
  authMethods: z.array(z.enum(['api_key', 'ed25519', 'oauth2'])).default(['api_key']),
  supportsStreaming: z.boolean().default(true),
  supportsAsync: z.boolean().default(true),
  rateLimit: z.object({
    requestsPerMinute: z.number().optional(),
    maxConcurrentRequests: z.number().optional(),
  }).optional(),
  extensions: z.array(z.object({
    name: z.string(),
    version: z.string(),
    url: z.string().url().optional(),
  })).default([]),
  tags: z.array(z.string()).default([]),
  icon: z.string().url().optional(),
  website: z.string().url().optional(),
})

export type AgentCard = z.infer<typeof AgentCardSchema>

// --- JSON-RPC 2.0 ---
// Ref: https://www.jsonrpc.org/specification

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
  id: z.union([z.string(), z.number()]).optional(),
})

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0'
  result?: T
  error?: { code: number; message: string; data?: unknown }
  id?: string | number
}

// --- A2A Method Types ---

export type A2AMethod = 'executeTask' | 'getStatus' | 'cancelTask' | 'discoverAgents'

export type A2AMethodHandler = (params: Record<string, unknown>, context: A2AContext) => Promise<unknown>

export interface A2AContext {
  agentId: string
  requesterId: string
  timestamp: Date
}

export type A2ATaskStatus = 'submitted' | 'working' | 'completed' | 'failed' | 'cancelled'

// --- A2A Client Options ---

export interface A2AClientOptions {
  timeout?: number
  credentialId?: string | null
  retryAttempts?: number
}

// --- JSON-RPC Error Codes ---

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  AUTH_FAILED: -32000,
} as const
