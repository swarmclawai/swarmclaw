import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { buildCrudTools } from './crud'
import type { ToolBuildContext } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

function parsePlatformData(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Preserve non-JSON data strings as-is in the caller.
  }
  return null
}

function firstPlatformResource(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null
  const first = value.find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
  return first && typeof first === 'object' && !Array.isArray(first)
    ? first as Record<string, unknown>
    : null
}

function normalizePlatformResourceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (!normalized) return undefined
  const singularMap: Record<string, string> = {
    agent: 'agents',
    task: 'tasks',
    backlog_task: 'tasks',
    'backlog-task': 'tasks',
    backlogtask: 'tasks',
    task_backlog: 'tasks',
    'task-backlog': 'tasks',
    work_item: 'tasks',
    'work-item': 'tasks',
    schedule: 'schedules',
    skill: 'skills',
    document: 'documents',
    secret: 'secrets',
    connector: 'connectors',
    session: 'sessions',
  }
  return singularMap[normalized] || normalized
}

function inferPlatformResourceFromAction(value: unknown): { resource?: string; action?: string } {
  if (typeof value !== 'string') return {}
  const normalized = value.trim().toLowerCase().replace(/-/g, '_')
  if (!normalized) return {}
  const match = normalized.match(/^(list|get|create|update|delete)_([a-z_]+)$/)
  if (!match) return {}
  const [, action, rawResource] = match
  const resource = normalizePlatformResourceName(rawResource)
  if (!resource) return {}
  return { resource, action }
}

function extractPlatformFields(value: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const [key, fieldValue] of Object.entries(value)) {
    if (fieldValue === undefined || fieldValue === null) continue
    if (['input', 'args', 'arguments', 'payload', 'resources', 'parameters', 'resource', 'type', 'action', 'id'].includes(key)) continue
    fields[key] = fieldValue
  }
  return fields
}

export function normalizePlatformActionArgs(rawArgs: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeToolInputArgs(rawArgs)
  const resourceEntry = firstPlatformResource(normalized.resources)
  const { resource, action, id, data, ...rest } = normalized
  const payload: Record<string, unknown> = {}
  const resourceValue = resource ?? resourceEntry?.resource ?? resourceEntry?.type
  const rawResourceName = typeof resourceValue === 'string'
    ? String(resourceValue).trim()
    : undefined

  const rawAction = action ?? resourceEntry?.action
  const inferredFromAction = resourceValue === undefined
    ? inferPlatformResourceFromAction(rawAction)
    : {}
  const effectiveResource = normalizePlatformResourceName(resourceValue) ?? inferredFromAction.resource
  const effectiveAction = inferredFromAction.action && resourceValue === undefined
    ? inferredFromAction.action
    : rawAction
  const effectiveId = id ?? resourceEntry?.id

  if (effectiveResource !== undefined) payload.resource = effectiveResource
  if (effectiveAction !== undefined) payload.action = effectiveAction
  if (effectiveId !== undefined) payload.id = effectiveId

  const directFields = extractPlatformFields(rest)
  const resourcePayloadCandidates = effectiveResource
    ? uniqueStrings([
        rawResourceName,
        effectiveResource,
        effectiveResource.replace(/s$/, ''),
      ])
    : []
  const directResourcePayload = resourcePayloadCandidates
    .map((candidate) => parsePlatformData(normalized[candidate]))
    .find(Boolean)
    || null
  if (effectiveResource) {
    for (const candidate of resourcePayloadCandidates) delete directFields[candidate]
  }
  const parameterFields = {
    ...(parsePlatformData(resourceEntry?.parameters) || {}),
    ...(parsePlatformData(resourceEntry?.params) || {}),
    ...(parsePlatformData(normalized.parameters) || {}),
    ...(directResourcePayload || {}),
  }
  const parsedData = parsePlatformData(data)
  const mergedData = {
    ...(parsedData || {}),
    ...parameterFields,
    ...directFields,
  }

  if (Object.keys(mergedData).length > 0) {
    payload.data = JSON.stringify(mergedData)
  } else if (typeof data === 'string' && data.trim()) {
    payload.data = data
  }

  return payload
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

/**
 * Unified Platform Execution Logic
 */
async function executePlatformAction(args: any, bctx: any) {
  const normalized = normalizePlatformActionArgs((args ?? {}) as Record<string, unknown>)
  const { resource, action, id, data } = normalized
  
  // We reuse the existing CRUD tool logic but expose it via a single tool
  const crudTools = buildCrudTools({
    ...bctx,
    hasPlugin: (id: string) => [
      'manage_agents',
      'manage_tasks',
      'manage_schedules',
      'manage_skills',
      'manage_documents',
      'manage_secrets',
      'manage_connectors',
      'manage_sessions'
    ].includes(id)
  })

  const targetToolName = `manage_${resource}`
  const targetTool = crudTools.find(t => t.name === targetToolName)
  
  if (!targetTool) {
    return `Error: Unknown resource type "${resource}". Valid resources: agents, tasks, schedules, skills, documents, secrets, connectors, sessions.`
  }

  // Forward to the specific CRUD tool implementation
  return targetTool.invoke({ action, id, data })
}

/**
 * Register as a Built-in Plugin
 */
const PlatformPlugin: Plugin = {
  name: 'Core Platform',
  description: 'Unified management of agents, tasks, schedules, skills, documents, and secrets.',
  hooks: {
    getCapabilityDescription: () => 'I can create and configure other agents (`manage_agents`), manage tasks (`manage_tasks`), set up schedules (`manage_schedules`), store and search documents (`manage_documents`), register webhooks (`manage_webhooks`), manage reusable skills (`manage_skills`), and store encrypted secrets (`manage_secrets`).',
    getOperatingGuidance: () => ['Create/update tasks for long-lived goals to track progress.', 'Use schedules for follow-ups. Check existing schedules before creating new ones.', 'Inspect existing chats before creating duplicates.'],
  } as PluginHooks,
  tools: [
    {
      name: 'manage_platform',
      description: 'Unified tool for managing all SwarmClaw resources. For create/update, pass resource + action, then either put fields inside data, pass them as top-level fields, or use a single resources[0].parameters envelope.',
      parameters: {
        type: 'object',
        properties: {
          resource: { type: 'string', enum: ['agents', 'tasks', 'schedules', 'skills', 'documents', 'secrets', 'connectors', 'sessions'] },
          action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'delete'] },
          id: { type: 'string' },
          data: { type: 'string' }
        },
        required: ['resource', 'action']
      },
      execute: async (args, context) => executePlatformAction(args, { ...context.session, ctx: context.session })
    }
  ]
}

getPluginManager().registerBuiltin('manage_platform', PlatformPlugin)

/**
 * Legacy Bridge
 */
export function buildPlatformTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('manage_platform')) return []

  return [
    tool(
      async (args) => executePlatformAction(args, bctx),
      {
        name: 'manage_platform',
        description: PlatformPlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
