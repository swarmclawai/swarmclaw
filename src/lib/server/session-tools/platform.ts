import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { buildCrudTools } from './crud'
import type { ToolBuildContext } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

/**
 * Unified Platform Execution Logic
 */
async function executePlatformAction(args: any, bctx: any) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const { resource, action, id, data, ...rest } = normalized
  
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
  return targetTool.invoke({ action, id, data, ...rest })
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
      description: 'Unified tool for managing all SwarmClaw resources.',
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
