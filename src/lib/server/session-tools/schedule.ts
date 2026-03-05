import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import { enqueueSystemEvent } from '../system-events'
import { requestHeartbeatNow } from '../heartbeat-wake'
import type { ToolBuildContext } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

/**
 * Core Schedule Execution Logic
 */
async function executeScheduleWake(args: { delayMinutes: number; message: string }, context: { sessionId?: string }) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const delayMinutes = normalized.delayMinutes as number
  const message = normalized.message as string
  if (!context.sessionId) return 'Cannot schedule wake: no session context.'
  if (delayMinutes < 0 || delayMinutes > 1440) return 'delayMinutes must be between 0 and 1440 (24 hours).'

  if (delayMinutes === 0) {
    enqueueSystemEvent(context.sessionId, `[Scheduled Wake Event / Reminder] ${message}`)
    requestHeartbeatNow({ sessionId: context.sessionId, reason: 'scheduled_wake' })
    return 'Successfully scheduled an immediate wake event.'
  }

  const delayMs = delayMinutes * 60 * 1000
  setTimeout(() => {
    if (context.sessionId) {
      enqueueSystemEvent(context.sessionId, `[Scheduled Wake Event / Reminder] ${message}`)
      requestHeartbeatNow({ sessionId: context.sessionId, reason: 'scheduled_wake' })
    }
  }, delayMs)

  return `Successfully scheduled a wake event in ${delayMinutes} minutes.`
}

/**
 * Register as a Built-in Plugin
 */
const SchedulePlugin: Plugin = {
  name: 'Core Scheduler',
  description: 'Schedule wake events and reminders for agents.',
  hooks: {
    getCapabilityDescription: () => 'I can set a conversational timer (`schedule_wake`) to remind myself to check back on something later in this chat.',
  } as PluginHooks,
  tools: [
    {
      name: 'schedule_wake',
      description: 'Schedule a wake event (reminder) for yourself in this chatroom.',
      parameters: {
        type: 'object',
        properties: {
          delayMinutes: { type: 'number' },
          message: { type: 'string' }
        },
        required: ['delayMinutes', 'message']
      },
      execute: async (args, context) => executeScheduleWake(args as any, { sessionId: context.session.id })
    }
  ]
}

getPluginManager().registerBuiltin('schedule', SchedulePlugin)

/**
 * Legacy Bridge
 */
export function buildScheduleTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('schedule_wake')) return []
  return [
    tool(
      async (args) => executeScheduleWake(args as any, { sessionId: bctx.ctx?.sessionId || undefined }),
      {
        name: 'schedule_wake',
        description: SchedulePlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
