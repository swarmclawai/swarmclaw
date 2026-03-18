import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { ToolBuildContext } from './context'
import type { Extension, ExtensionHooks } from '@/types'
import { registerNativeCapability } from '../native-capabilities'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { errorMessage } from '@/lib/shared-utils'

const PROTOCOL_ACTIONS = [
  'list_templates', 'create_run', 'run_status', 'list_runs',
  'run_action', 'create_template', 'run_events',
] as const

type ProtocolAction = typeof PROTOCOL_ACTIONS[number]

/** Map short action aliases LLMs commonly send to canonical action names */
const PROTOCOL_ACTION_ALIASES: Record<string, ProtocolAction> = {
  templates: 'list_templates',
  list: 'list_runs',
  runs: 'list_runs',
  status: 'run_status',
  create: 'create_run',
  action: 'run_action',
  events: 'run_events',
  template: 'create_template',
}

/** Parse a value that might be a JSON-stringified array */
function coerceStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value as string[]
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[')) {
      try { const parsed = JSON.parse(trimmed); if (Array.isArray(parsed)) return parsed } catch { /* ignore */ }
    }
  }
  return undefined
}

/**
 * Core Protocol Execution Logic
 */
async function executeProtocolAction(
  args: Record<string, unknown>,
  context: { sessionId?: string | null },
) {
  const normalized = normalizeToolInputArgs(args)
  const rawAction = normalized.action as string
  const action = (PROTOCOL_ACTION_ALIASES[rawAction] || rawAction) as ProtocolAction
  const runId = (normalized.runId ?? normalized.run_id) as string | undefined
  const templateId = (normalized.templateId ?? normalized.template_id) as string | undefined
  const title = normalized.title as string | undefined
  const goal = normalized.goal as string | undefined
  const participantAgentIds = coerceStringArray(normalized.participantAgentIds ?? normalized.participant_agent_ids)
  const facilitatorAgentId = (normalized.facilitatorAgentId ?? normalized.facilitator_agent_id) as string | undefined
  const steps = normalized.steps as unknown[] | string | undefined
  const entryStepId = (normalized.entryStepId ?? normalized.entry_step_id) as string | undefined
  const runAction = (normalized.runAction ?? normalized.run_action) as string | undefined
  const name = normalized.name as string | undefined
  const description = normalized.description as string | undefined
  const tags = coerceStringArray(normalized.tags)
  const autoStart = (normalized.autoStart ?? normalized.auto_start) as boolean | undefined

  try {
    const {
      listProtocolTemplates,
      listProtocolRuns,
      loadProtocolRunById,
      listProtocolRunEventsForRun,
      createProtocolRun,
      requestProtocolRunExecution,
      performProtocolRunAction,
      createProtocolTemplate,
    } = await import('@/lib/server/protocols/protocol-service')

    if (action === 'list_templates') {
      const templates = listProtocolTemplates()
      return JSON.stringify(templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        tags: t.tags,
        builtIn: t.builtIn || false,
      })))
    }

    if (action === 'list_runs') {
      const runs = listProtocolRuns({ sessionId: context.sessionId || undefined, limit: 50 })
      return JSON.stringify(runs.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        templateName: r.templateName,
        participantCount: r.participantAgentIds?.length || 0,
        updatedAt: r.updatedAt,
      })))
    }

    if (action === 'run_status') {
      if (!runId) return 'Error: runId is required.'
      const run = loadProtocolRunById(runId)
      if (!run) return 'Error: run not found.'
      return JSON.stringify({
        id: run.id,
        title: run.title,
        status: run.status,
        templateName: run.templateName,
        currentStepId: run.currentStepId || null,
        currentPhaseIndex: run.currentPhaseIndex,
        participantAgentIds: run.participantAgentIds,
        summary: run.summary || null,
        artifacts: run.artifacts?.slice(0, 10) || [],
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      })
    }

    if (action === 'run_events') {
      if (!runId) return 'Error: runId is required.'
      const events = listProtocolRunEventsForRun(runId, 30)
      return JSON.stringify(events.map((e) => ({
        id: e.id,
        type: e.type,
        summary: e.summary,
        createdAt: e.createdAt,
      })))
    }

    if (action === 'create_run') {
      if (!title && !goal) return 'Error: title or goal is required.'
      if (!participantAgentIds?.length && !templateId) {
        return 'Error: participantAgentIds required (or provide a templateId with defaults).'
      }

      // Accept steps as JSON string or array
      let resolvedSteps: unknown[] | undefined
      if (typeof steps === 'string') {
        try { resolvedSteps = JSON.parse(steps) } catch { return 'Error: steps must be valid JSON array.' }
      } else if (Array.isArray(steps)) {
        resolvedSteps = steps
      }

      const run = createProtocolRun({
        title: (title || goal || 'Protocol Run'),
        templateId: templateId || null,
        steps: resolvedSteps as import('@/types').ProtocolStepDefinition[] | undefined,
        entryStepId: entryStepId || null,
        participantAgentIds: participantAgentIds || [],
        facilitatorAgentId: facilitatorAgentId || null,
        sessionId: context.sessionId || null,
        sourceRef: context.sessionId ? { kind: 'session', sessionId: context.sessionId } : { kind: 'manual' },
        autoStart: autoStart !== false,
      })

      if (autoStart !== false) {
        requestProtocolRunExecution(run.id)
      }

      return JSON.stringify({
        ok: true,
        runId: run.id,
        title: run.title,
        status: run.status,
        templateName: run.templateName,
      })
    }

    if (action === 'run_action') {
      if (!runId) return 'Error: runId is required.'
      if (!runAction) return 'Error: runAction is required (start, pause, resume, cancel).'
      const validActions = ['start', 'pause', 'resume', 'cancel'] as const
      if (!validActions.includes(runAction as typeof validActions[number])) {
        return `Error: runAction must be one of: ${validActions.join(', ')}`
      }
      const updated = performProtocolRunAction(runId, {
        action: runAction as 'start' | 'pause' | 'resume' | 'cancel',
      })
      if (!updated) return 'Error: run not found or action failed.'
      return JSON.stringify({
        ok: true,
        runId: updated.id,
        status: updated.status,
      })
    }

    if (action === 'create_template') {
      if (!name) return 'Error: name is required.'
      const template = createProtocolTemplate({
        name: name,
        description: description || '',
        tags: tags || [],
      })
      return JSON.stringify({
        ok: true,
        templateId: template.id,
        name: template.name,
      })
    }

    return `Unknown action "${action}".`
  } catch (err: unknown) {
    return `Error: ${errorMessage(err)}`
  }
}

/**
 * Register as a Built-in Extension
 */
const ProtocolExtension: Extension = {
  name: 'Core Protocols',
  description: 'Structured orchestration workflows: sequential, parallel, branching, looping, DAG, forEach, subflows, and swarm patterns.',
  hooks: {
    getCapabilityDescription: () =>
      'I can run structured orchestration workflows (`manage_protocols`) â€” conditional branching, looping, DAG dependencies, dynamic parallel (forEach), subflows, and competitive swarm patterns.',
    getOperatingGuidance: () => [
      'Step kinds: present, collect_independent_inputs, round_robin, compare, decide, summarize, emit_tasks, wait, dispatch_task, dispatch_delegation, branch, repeat, parallel, join, complete, for_each, subflow, swarm_claim.',
      'Each step requires `id`, `kind`, `label`. Chain steps with `nextStepId`. Per-kind config: `branchCases[]` + `defaultNextStepId` (branch), `repeat` (repeat), `parallel` (parallel), `forEach` (for_each), `subflow` (subflow), `swarm` (swarm_claim).',
      'For DAG patterns use `dependsOnStepIds[]` + `outputKey` to wire dependency graphs instead of linear nextStepId chains.',
    ].join('\n'),
  } as ExtensionHooks,
  tools: [
    {
      name: 'manage_protocols',
      description: 'Structured orchestration workflows. Actions: list_templates, create_run (title, participantAgentIds, templateId or steps), run_status (runId), list_runs, run_action (runId, runAction: start|pause|resume|cancel), create_template (name, description, tags), run_events (runId).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: PROTOCOL_ACTIONS as unknown as string[] },
          runId: { type: 'string' },
          templateId: { type: 'string' },
          title: { type: 'string' },
          goal: { type: 'string' },
          participantAgentIds: { type: 'array', items: { type: 'string' } },
          facilitatorAgentId: { type: 'string' },
          steps: {},
          entryStepId: { type: 'string' },
          runAction: { type: 'string', enum: ['start', 'pause', 'resume', 'cancel'] },
          name: { type: 'string' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          autoStart: { type: 'boolean' },
        },
        required: ['action'],
      },
      execute: async (args, context) =>
        executeProtocolAction(args as Record<string, unknown>, { sessionId: (context.session as unknown as Record<string, unknown>).sessionId as string | undefined }),
    },
  ],
}

registerNativeCapability('protocol', ProtocolExtension)

/**
 * Legacy Bridge
 */
export function buildProtocolTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasExtension('manage_protocols')) return []
  return [
    tool(
      async (args) => executeProtocolAction(args as Record<string, unknown>, { sessionId: bctx.ctx?.sessionId }),
      {
        name: 'manage_protocols',
        description: ProtocolExtension.tools![0].description,
        schema: z.object({
          action: z.enum(PROTOCOL_ACTIONS)
            .describe('The protocol action to perform'),
          runId: z.string().optional().describe('Required for run_status, run_events, run_action'),
          templateId: z.string().optional().describe('Template ID for create_run'),
          title: z.string().optional().describe('Title for create_run'),
          goal: z.string().optional().describe('Goal description for create_run'),
          participantAgentIds: z.array(z.string()).optional().describe('Agent IDs to participate'),
          facilitatorAgentId: z.string().optional(),
          steps: z.union([z.array(z.object({}).passthrough()), z.string()]).optional()
            .describe('Custom workflow steps (array or JSON string)'),
          entryStepId: z.string().optional(),
          runAction: z.enum(['start', 'pause', 'resume', 'cancel']).optional()
            .describe('Action for run_action'),
          name: z.string().optional().describe('Name for create_template'),
          description: z.string().optional(),
          tags: z.array(z.string()).optional(),
          autoStart: z.boolean().optional().describe('Auto-start the run after creation (default true)'),
        }).passthrough(),
      },
    ),
  ]
}
