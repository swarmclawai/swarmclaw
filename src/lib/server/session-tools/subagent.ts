import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { genId } from '@/lib/id'
import { DEFAULT_DELEGATION_MAX_DEPTH } from '@/lib/runtime-loop'
import { loadAgents, loadSessions, saveSessions } from '../storage'
import { enqueueSessionRun } from '../session-run-manager'
import { loadRuntimeSettings } from '../runtime-settings'
import type { ToolBuildContext } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'
import {
  appendDelegationCheckpoint,
  cancelDelegationJob,
  completeDelegationJob,
  createDelegationJob,
  failDelegationJob,
  getDelegationJob,
  listDelegationJobs,
  recoverStaleDelegationJobs,
  registerDelegationRuntime,
  startDelegationJob,
} from '../delegation-jobs'

function getSessionDepth(sessionId: string | undefined, maxDepth: number): number {
  if (!sessionId) return 0
  const sessions = loadSessions()
  let depth = 0
  let current = sessionId
  while (current && depth < maxDepth + 1) {
    const session = sessions[current]
    if (!session?.parentSessionId) break
    current = session.parentSessionId as string
    depth++
  }
  return depth
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function resolveSubagentBrowserProfileId(
  parentSession: Record<string, unknown> | null | undefined,
  childSessionId: string,
  shareBrowserProfile: boolean,
): string {
  if (!shareBrowserProfile) return childSessionId
  const inherited = typeof parentSession?.browserProfileId === 'string' && parentSession.browserProfileId.trim()
    ? parentSession.browserProfileId.trim()
    : typeof parentSession?.id === 'string' && parentSession.id.trim()
      ? parentSession.id.trim()
      : ''
  return inherited || childSessionId
}

async function startSubagentJob(jobId: string, args: {
  agentId: string
  message: string
  cwd?: string
  shareBrowserProfile?: boolean
}, context: { sessionId?: string; cwd: string }) {
  const runtime = loadRuntimeSettings()
  const maxDepth = runtime.delegationMaxDepth || DEFAULT_DELEGATION_MAX_DEPTH
  const agents = loadAgents()
  const agent = agents[args.agentId]
  if (!agent) throw new Error(`Agent "${args.agentId}" not found.`)

  const depth = getSessionDepth(context.sessionId, maxDepth)
  if (depth >= maxDepth) throw new Error('Max subagent depth reached.')

  const sid = genId()
  const now = Date.now()
  const sessions = loadSessions()
  const parent = context.sessionId ? sessions[context.sessionId] : null
  const browserProfileId = resolveSubagentBrowserProfileId(parent, sid, args.shareBrowserProfile === true)
  sessions[sid] = {
    id: sid,
    name: `subagent-${agent.name}`,
    cwd: args.cwd || context.cwd,
    user: 'agent',
    provider: agent.provider,
    model: agent.model,
    credentialId: agent.credentialId || null,
    messages: [],
    createdAt: now,
    lastActiveAt: now,
    sessionType: 'orchestrated',
    agentId: agent.id,
    parentSessionId: context.sessionId || null,
    plugins: agent.plugins || agent.tools || [],
    browserProfileId,
  }
  saveSessions(sessions)

  startDelegationJob(jobId, {
    childSessionId: sid,
    agentId: agent.id,
    agentName: agent.name,
    cwd: args.cwd || context.cwd,
  })
  appendDelegationCheckpoint(jobId, `Created child session ${sid}`, 'running')

  const run = enqueueSessionRun({
    sessionId: sid,
    message: args.message,
    internal: true,
    source: 'subagent',
    mode: 'followup',
  })

  registerDelegationRuntime(jobId, {
    cancel: () => run.abort(),
  })

  run.promise
    .then((result) => {
      const latest = getDelegationJob(jobId)
      if (latest?.status === 'cancelled') return
      appendDelegationCheckpoint(jobId, 'Child session completed', 'completed')
      completeDelegationJob(jobId, result.text.slice(0, 8000), { childSessionId: sid })
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      const latest = getDelegationJob(jobId)
      if (latest?.status === 'cancelled') return
      appendDelegationCheckpoint(jobId, `Child session failed: ${message}`, 'failed')
      failDelegationJob(jobId, message, { childSessionId: sid })
    })

  return { run, sid, agent }
}

async function waitForSubagentJob(jobId: string, timeoutSec = 30): Promise<string> {
  const timeoutAt = Date.now() + Math.max(1, timeoutSec) * 1000
  while (Date.now() < timeoutAt) {
    const job = getDelegationJob(jobId)
    if (!job) return `Error: delegation job "${jobId}" not found.`
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return JSON.stringify(job)
    }
    await sleep(1000)
  }
  const latest = getDelegationJob(jobId)
  return latest ? JSON.stringify(latest) : `Error: delegation job "${jobId}" not found.`
}

/**
 * Core Subagent Execution Logic
 */
async function executeSubagentAction(args: any, context: { sessionId?: string; cwd: string }) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const action = String(normalized.action || '').trim().toLowerCase()
  const agentId = (normalized.agentId ?? normalized.agent_id) as string | undefined
  const message = normalized.message as string | undefined
  const cwd = normalized.cwd as string | undefined
  const shareBrowserProfile = normalized.shareBrowserProfile === true || normalized.share_browser_profile === true
  const jobId = typeof normalized.jobId === 'string' ? normalized.jobId.trim() : ''
  const waitForCompletion = normalized.waitForCompletion !== false && normalized.background !== true

  recoverStaleDelegationJobs()

  try {
    if (action === 'status') {
      if (!jobId) return 'Error: jobId is required.'
      const job = getDelegationJob(jobId)
      return job ? JSON.stringify(job) : `Error: delegation job "${jobId}" not found.`
    }
    if (action === 'list') {
      return JSON.stringify(listDelegationJobs({ parentSessionId: context.sessionId || null }))
    }
    if (action === 'cancel') {
      if (!jobId) return 'Error: jobId is required.'
      const job = cancelDelegationJob(jobId)
      return job ? JSON.stringify(job) : `Error: delegation job "${jobId}" not found.`
    }
    if (action === 'wait') {
      if (!jobId) return 'Error: jobId is required.'
      const timeoutSec = typeof normalized.timeoutSec === 'number' ? normalized.timeoutSec : 30
      return waitForSubagentJob(jobId, timeoutSec)
    }

    if (!agentId) return 'Error: agentId is required.'
    if (!message) return 'Error: message is required.'

    const job = createDelegationJob({
      kind: 'subagent',
      parentSessionId: context.sessionId || null,
      agentId,
      task: message,
      cwd: cwd || context.cwd,
    })
    appendDelegationCheckpoint(job.id, `Starting subagent ${agentId}`, 'queued')
    const started = await startSubagentJob(job.id, { agentId, message, cwd, shareBrowserProfile }, context)

    if (!waitForCompletion) {
      return JSON.stringify({
        jobId: job.id,
        status: 'running',
        agentId,
        agentName: started.agent.name,
        sessionId: started.sid,
      })
    }

    const result = await started.run.promise
    const completed = getDelegationJob(job.id)
    return JSON.stringify({
      jobId: job.id,
      status: completed?.status || 'completed',
      agentId,
      agentName: started.agent.name,
      sessionId: started.sid,
      response: result.text.slice(0, 8000),
    })
  } catch (err: any) {
    return `Error: ${err.message}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const SubagentPlugin: Plugin = {
  name: 'Core Subagents',
  description: 'Delegate tasks to other specialized agents with resumable job handles.',
  hooks: {} as PluginHooks,
  tools: [
    {
      name: 'spawn_subagent',
      description: 'Delegate a task to another agent. Supports background jobs with action=status|list|wait|cancel and waitForCompletion=false.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'status', 'list', 'wait', 'cancel'] },
          agentId: { type: 'string' },
          message: { type: 'string' },
          cwd: { type: 'string' },
          shareBrowserProfile: {
            type: 'boolean',
            description: 'When true, inherit the parent session browser profile. Defaults to false so subagents get isolated browser state.',
          },
          jobId: { type: 'string' },
          waitForCompletion: { type: 'boolean' },
          background: { type: 'boolean' },
          timeoutSec: { type: 'number' },
        },
        required: []
      },
      execute: async (args, context) => executeSubagentAction(args, { sessionId: context.session.id, cwd: context.session.cwd || process.cwd() })
    }
  ]
}

getPluginManager().registerBuiltin('subagent', SubagentPlugin)

/**
 * Legacy Bridge
 */
export function buildSubagentTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('spawn_subagent')) return []
  return [
    tool(
      async (args) => executeSubagentAction(args, { sessionId: bctx.ctx?.sessionId || undefined, cwd: bctx.cwd }),
      {
        name: 'spawn_subagent',
        description: SubagentPlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
