import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { Plugin, PluginHooks } from '@/types'
import type { ToolBuildContext } from './context'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { ackMailboxEnvelope, listMailbox, sendMailboxEnvelope } from '../session-mailbox'
import { loadApprovals } from '../storage'
import { requestApprovalMaybeAutoApprove } from '../approvals'
import { createWatchJob, getWatchJob } from '../watch-jobs'

async function executeHumanLoopAction(args: Record<string, unknown>, bctx: { sessionId?: string | null; agentId?: string | null }) {
  const normalized = normalizeToolInputArgs(args)
  const action = String(normalized.action || '').trim().toLowerCase()

  try {
    if (action === 'request_input') {
      const toSessionId = typeof normalized.toSessionId === 'string' ? normalized.toSessionId : bctx.sessionId
      if (!toSessionId) return 'Error: toSessionId or current session is required.'
      const question = typeof normalized.question === 'string' ? normalized.question.trim() : ''
      if (!question) return 'Error: question is required.'
      const correlationId = typeof normalized.correlationId === 'string' ? normalized.correlationId.trim() : `human-${Date.now()}`
      const options = Array.isArray(normalized.options)
        ? normalized.options.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : []
      const envelope = sendMailboxEnvelope({
        toSessionId,
        type: typeof normalized.type === 'string' ? normalized.type : 'human_request',
        payload: JSON.stringify({
          question,
          options,
          expectedFormat: typeof normalized.expectedFormat === 'string' ? normalized.expectedFormat : null,
          notes: typeof normalized.notes === 'string' ? normalized.notes : null,
        }),
        fromSessionId: bctx.sessionId || null,
        fromAgentId: bctx.agentId || null,
        correlationId,
        ttlSec: typeof normalized.ttlSec === 'number' ? normalized.ttlSec : null,
      })
      return JSON.stringify({
        ok: true,
        envelope,
        correlationId,
        hint: `A human can answer via POST /api/chats/${toSessionId}/mailbox with action="send", type="human_reply", correlationId="${correlationId}", and payload set to the response.`,
      })
    }

    if (action === 'list_mailbox') {
      const sessionId = typeof normalized.sessionId === 'string' ? normalized.sessionId : bctx.sessionId
      if (!sessionId) return 'Error: sessionId or current session is required.'
      const includeAcked = normalized.includeAcked === true
      return JSON.stringify(listMailbox(sessionId, {
        includeAcked,
        limit: typeof normalized.limit === 'number' ? normalized.limit : undefined,
      }))
    }

    if (action === 'ack_mailbox') {
      const sessionId = typeof normalized.sessionId === 'string' ? normalized.sessionId : bctx.sessionId
      if (!sessionId) return 'Error: sessionId or current session is required.'
      const envelopeId = typeof normalized.envelopeId === 'string' ? normalized.envelopeId.trim() : ''
      if (!envelopeId) return 'Error: envelopeId is required.'
      const envelope = ackMailboxEnvelope(sessionId, envelopeId)
      return envelope ? JSON.stringify(envelope) : `Error: mailbox envelope "${envelopeId}" not found.`
    }

    if (action === 'request_approval') {
      const title = typeof normalized.title === 'string' && normalized.title.trim()
        ? normalized.title.trim()
        : 'Human approval requested'
      const approval = await requestApprovalMaybeAutoApprove({
        category: 'human_loop',
        title,
        description: typeof normalized.description === 'string' ? normalized.description : undefined,
        agentId: bctx.agentId || null,
        sessionId: bctx.sessionId || null,
        data: {
          question: typeof normalized.question === 'string' ? normalized.question : title,
          options: Array.isArray(normalized.options) ? normalized.options : undefined,
          metadata: normalized.metadata,
        },
      })
      return JSON.stringify(approval)
    }

    if (action === 'wait_for_reply') {
      const sessionId = typeof normalized.sessionId === 'string' ? normalized.sessionId : bctx.sessionId
      if (!sessionId) return 'Error: sessionId or current session is required.'
      const job = await createWatchJob({
        type: 'mailbox',
        sessionId,
        agentId: bctx.agentId || null,
        createdByAgentId: bctx.agentId || null,
        resumeMessage: typeof normalized.resumeMessage === 'string' && normalized.resumeMessage.trim()
          ? normalized.resumeMessage.trim()
          : 'A human reply arrived in the mailbox. Read it and continue the task.',
        description: typeof normalized.description === 'string' ? normalized.description : 'Wait for mailbox reply',
        timeoutAt: typeof normalized.timeoutMinutes === 'number'
          ? Date.now() + Math.max(1, normalized.timeoutMinutes) * 60_000
          : undefined,
        target: {
          sessionId,
        },
        condition: {
          type: typeof normalized.type === 'string' ? normalized.type : 'human_reply',
          correlationId: typeof normalized.correlationId === 'string' ? normalized.correlationId : undefined,
          fromSessionId: typeof normalized.fromSessionId === 'string' ? normalized.fromSessionId : undefined,
          containsText: typeof normalized.containsText === 'string' ? normalized.containsText : undefined,
        },
      })
      return JSON.stringify(job)
    }

    if (action === 'wait_for_approval') {
      const approvalId = typeof normalized.approvalId === 'string' ? normalized.approvalId.trim() : ''
      if (!approvalId) return 'Error: approvalId is required.'
      const job = await createWatchJob({
        type: 'approval',
        sessionId: bctx.sessionId || null,
        agentId: bctx.agentId || null,
        createdByAgentId: bctx.agentId || null,
        resumeMessage: typeof normalized.resumeMessage === 'string' && normalized.resumeMessage.trim()
          ? normalized.resumeMessage.trim()
          : 'A human approval decision was made. Inspect it and continue the task.',
        description: typeof normalized.description === 'string' ? normalized.description : 'Wait for approval decision',
        timeoutAt: typeof normalized.timeoutMinutes === 'number'
          ? Date.now() + Math.max(1, normalized.timeoutMinutes) * 60_000
          : undefined,
        target: {
          approvalId,
        },
        condition: {
          statusIn: Array.isArray(normalized.statusIn)
            ? normalized.statusIn.filter((value): value is string => typeof value === 'string')
            : ['approved', 'rejected'],
        },
      })
      return JSON.stringify(job)
    }

    if (action === 'status') {
      const approvalId = typeof normalized.approvalId === 'string' ? normalized.approvalId.trim() : ''
      const watchJobId = typeof normalized.watchJobId === 'string' ? normalized.watchJobId.trim() : ''
      if (approvalId) {
        const approvals = loadApprovals()
        const approval = approvals[approvalId]
        return approval ? JSON.stringify(approval) : `Error: approval "${approvalId}" not found.`
      }
      if (watchJobId) {
        const watch = getWatchJob(watchJobId)
        return watch ? JSON.stringify(watch) : `Error: watch job "${watchJobId}" not found.`
      }
      return 'Error: approvalId or watchJobId is required for status.'
    }

    return `Error: Unknown action "${action}".`
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

const HumanLoopPlugin: Plugin = {
  name: 'Human Loop',
  enabledByDefault: false,
  description: 'Request structured human input or approvals, then wait durably for the response.',
  hooks: {
    getCapabilityDescription: () =>
      'I can request structured human input or explicit approvals with `ask_human`, then pause on durable wait handles until the response arrives.',
  } as PluginHooks,
  tools: [
    {
      name: 'ask_human',
      description: 'Human-loop tool. Actions: request_input, request_approval, wait_for_reply, wait_for_approval, list_mailbox, ack_mailbox, status.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['request_input', 'request_approval', 'wait_for_reply', 'wait_for_approval', 'list_mailbox', 'ack_mailbox', 'status'] },
          question: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          correlationId: { type: 'string' },
          expectedFormat: { type: 'string' },
          notes: { type: 'string' },
          envelopeId: { type: 'string' },
          sessionId: { type: 'string' },
          toSessionId: { type: 'string' },
          approvalId: { type: 'string' },
          watchJobId: { type: 'string' },
          statusIn: { type: 'array', items: { type: 'string' } },
          type: { type: 'string' },
          fromSessionId: { type: 'string' },
          containsText: { type: 'string' },
          ttlSec: { type: 'number' },
          timeoutMinutes: { type: 'number' },
          resumeMessage: { type: 'string' },
          limit: { type: 'number' },
          includeAcked: { type: 'boolean' },
        },
        required: ['action'],
      },
      execute: async (args, context) => executeHumanLoopAction(args, {
        sessionId: context.session.id,
        agentId: context.session.agentId || null,
      }),
    },
  ],
}

getPluginManager().registerBuiltin('ask_human', HumanLoopPlugin)

export function buildHumanLoopTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('ask_human')) return []
  return [
    tool(
      async (args) => executeHumanLoopAction(args, {
        sessionId: bctx.ctx?.sessionId || null,
        agentId: bctx.ctx?.agentId || null,
      }),
      {
        name: 'ask_human',
        description: HumanLoopPlugin.tools![0].description,
        schema: z.object({}).passthrough(),
      },
    ),
  ]
}
