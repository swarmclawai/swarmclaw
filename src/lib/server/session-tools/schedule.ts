import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import { enqueueSystemEvent } from '../system-events'
import { requestHeartbeatNow } from '../heartbeat-wake'
import type { ToolBuildContext } from './context'

export function buildScheduleTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { ctx, hasTool } = bctx

  if (hasTool('schedule_wake')) {
    tools.push(
      tool(
        async ({ delayMinutes, message }) => {
          if (!ctx?.sessionId) return 'Cannot schedule wake: no session context.'
          if (delayMinutes <= 0 || delayMinutes > 1440) return 'delayMinutes must be between 1 and 1440 (24 hours).'

          // Non-durable in-memory timeout for conversational wake events
          // (For durable cron, use manage_schedules)
          const delayMs = delayMinutes * 60 * 1000
          setTimeout(() => {
            if (ctx.sessionId) {
              enqueueSystemEvent(ctx.sessionId, `[Scheduled Wake Event / Reminder] ${message}`)
              requestHeartbeatNow({ sessionId: ctx.sessionId, reason: 'scheduled_wake' })
            }
          }, delayMs)

          return `Successfully scheduled a wake event in ${delayMinutes} minutes with message: "${message}".`
        },
        {
          name: 'schedule_wake',
          description: 'Schedule a wake event (reminder) for yourself in this chatroom. Use this to proactively check back on a long-running process or to remind yourself to follow up with the user later.',
          schema: z.object({
            delayMinutes: z.number().describe('How many minutes from now to wake up (1-1440).'),
            message: z.string().describe('The reminder text that will be passed back to you when you wake.'),
          }),
        },
      ),
    )
  }

  return tools
}
