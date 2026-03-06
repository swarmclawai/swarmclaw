import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import * as os from 'os'
import type { ToolBuildContext } from './context'
import { getPluginManager } from '../plugins'
import type { Plugin, PluginHooks } from '@/types'
import { safePath, truncate } from './context'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { cancelWatchJob, createWatchJob, getWatchJob, listWatchJobs } from '../watch-jobs'
import { ensureSessionBrowserProfileId, loadBrowserSessionRecord } from '../browser-state'

type WatchKind = 'time' | 'http' | 'file' | 'task' | 'webhook' | 'page'

async function createDurableWatch(
  normalized: Record<string, unknown>,
  bctx: { cwd: string; sessionId?: string; agentId?: string | null },
  explicitType?: WatchKind,
) {
  const watchType = (explicitType || String(normalized.watchType || normalized.type || '').trim().toLowerCase()) as WatchKind
  if (!watchType) return 'Error: watchType is required.'
  if (!['time', 'http', 'file', 'task', 'webhook', 'page'].includes(watchType)) {
    return `Error: Unsupported watchType "${watchType}".`
  }

  const sessionId = typeof normalized.sessionId === 'string' ? normalized.sessionId : bctx.sessionId
  const agentId = typeof normalized.agentId === 'string' ? normalized.agentId : (bctx.agentId || undefined)
  const resumeMessage = String(normalized.resumeMessage || normalized.message || '').trim()
  if (!resumeMessage) return 'Error: resumeMessage is required.'

  const target = (normalized.target ?? normalized.url ?? normalized.path) as string | undefined
  const delayMinutes = typeof normalized.delayMinutes === 'number' ? normalized.delayMinutes : undefined
  const runAt = typeof normalized.runAt === 'number'
    ? normalized.runAt
    : delayMinutes !== undefined
      ? Date.now() + Math.max(0, delayMinutes) * 60_000
      : undefined
  const intervalMs = typeof normalized.intervalSec === 'number'
    ? Math.max(15, normalized.intervalSec) * 1000
    : typeof normalized.intervalMs === 'number'
      ? Math.max(15_000, normalized.intervalMs)
      : undefined
  const timeoutAt = typeof normalized.timeoutMinutes === 'number'
    ? Date.now() + Math.max(1, normalized.timeoutMinutes) * 60_000
    : typeof normalized.timeoutAt === 'number'
      ? normalized.timeoutAt
      : undefined
  const browserProfileId = sessionId ? ensureSessionBrowserProfileId(sessionId).profileId : null
  const targetPath = watchType === 'file' && target ? safePath(bctx.cwd, target) : target
  const pageUrl = watchType === 'page' && !target && sessionId
    ? loadBrowserSessionRecord(sessionId)?.currentUrl || undefined
    : undefined
  const pageTarget = target || pageUrl
  if ((watchType === 'http' || watchType === 'page') && !pageTarget) {
    return `Error: ${watchType === 'page' ? 'url or active browser page' : 'url'} is required.`
  }

  const job = await createWatchJob({
    type: watchType,
    sessionId: sessionId || null,
    agentId: agentId || null,
    createdByAgentId: agentId || null,
    browserProfileId,
    description: typeof normalized.description === 'string' ? normalized.description : null,
    resumeMessage,
    runAt,
    intervalMs,
    timeoutAt,
    target: {
      url: watchType === 'http' || watchType === 'page' ? pageTarget : undefined,
      path: watchType === 'file' ? targetPath : undefined,
      taskId: watchType === 'task' ? String(normalized.taskId || normalized.id || '') : undefined,
      webhookId: watchType === 'webhook' ? String(normalized.webhookId || normalized.id || '') : undefined,
      baselineHash: undefined,
    },
    condition: {
      containsText: typeof normalized.containsText === 'string' ? normalized.containsText : undefined,
      textGone: typeof normalized.textGone === 'string' ? normalized.textGone : undefined,
      regex: typeof normalized.regex === 'string' ? normalized.regex : undefined,
      changed: normalized.changed === true,
      exists: normalized.exists,
      status: typeof normalized.status === 'number' ? normalized.status : undefined,
      statusIn: Array.isArray(normalized.statusIn) ? normalized.statusIn : undefined,
      event: typeof normalized.event === 'string' ? normalized.event : undefined,
      threshold: typeof normalized.threshold === 'number' ? normalized.threshold : undefined,
    },
  })
  return JSON.stringify(job, null, 2)
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Unified Monitoring Logic
 */
async function executeMonitorAction(
  args: Record<string, unknown> | undefined,
  bctx: { cwd: string; sessionId?: string; agentId?: string | null },
) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const action = normalized.action as string | undefined
  const target = (normalized.target ?? normalized.url ?? normalized.path) as string | undefined
  const limit = normalized.limit as number | undefined
  const threshold = normalized.threshold as number | undefined
  const sessionId = typeof normalized.sessionId === 'string' ? normalized.sessionId : bctx.sessionId
  void limit
  void sessionId

  try {
    switch (action) {
      case 'sys_info': {
        const freeMem = os.freemem()
        const totalMem = os.totalmem()
        const load = os.loadavg()
        const uptime = os.uptime()
        return JSON.stringify({
          platform: os.platform(),
          arch: os.arch(),
          cpus: os.cpus().length,
          memory: {
            free: `${Math.round(freeMem / 1024 / 1024)}MB`,
            total: `${Math.round(totalMem / 1024 / 1024)}MB`,
            usage: `${Math.round(((totalMem - freeMem) / totalMem) * 100)}%`
          },
          loadAvg: load,
          uptime: `${Math.round(uptime / 3600)} hours`
        }, null, 2)
      }

      case 'watch_log': {
        const resolved = safePath(bctx.cwd, target!)
        if (!fs.existsSync(resolved)) return `Error: File not found ${target}`
        
        const stats = fs.statSync(resolved)
        const size = stats.size
        const bufferSize = Math.min(size, 5000) // Read last 5KB
        const fd = fs.openSync(resolved, 'r')
        const buffer = Buffer.alloc(bufferSize)
        fs.readSync(fd, buffer, 0, bufferSize, size - bufferSize)
        fs.closeSync(fd)
        
        return truncate(buffer.toString('utf8'), 2000)
      }

      case 'ping': {
        const url = target?.startsWith('http') ? target : `http://${target}`
        const start = Date.now()
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
          const latency = Date.now() - start
          return JSON.stringify({
            status: res.status,
            ok: res.ok,
            latency: `${latency}ms`,
            thresholdExceeded: typeof threshold === 'number' ? latency >= threshold : undefined,
            url
          }, null, 2)
        } catch (err: unknown) {
          return JSON.stringify({
            status: 'error',
            error: getErrorMessage(err),
            url
          }, null, 2)
        }
      }

      case 'create_watch': {
        return createDurableWatch(normalized, bctx)
      }

      case 'wait_until': {
        return createDurableWatch(normalized, bctx, 'time')
      }

      case 'wait_for_http': {
        return createDurableWatch(normalized, bctx, 'http')
      }

      case 'wait_for_file': {
        return createDurableWatch(normalized, bctx, 'file')
      }

      case 'wait_for_task': {
        return createDurableWatch(normalized, bctx, 'task')
      }

      case 'wait_for_webhook': {
        return createDurableWatch(normalized, bctx, 'webhook')
      }

      case 'wait_for_page_change': {
        return createDurableWatch(normalized, bctx, 'page')
      }

      case 'list_watches': {
        const filterSessionId = normalized.all === true ? undefined : sessionId
        return JSON.stringify(listWatchJobs({ sessionId: filterSessionId || null }), null, 2)
      }

      case 'get_watch': {
        const id = String(normalized.id || '').trim()
        if (!id) return 'Error: id is required.'
        const job = getWatchJob(id)
        if (!job) return `Error: watch job "${id}" not found.`
        return JSON.stringify(job, null, 2)
      }

      case 'cancel_watch': {
        const id = String(normalized.id || '').trim()
        if (!id) return 'Error: id is required.'
        const job = cancelWatchJob(id)
        if (!job) return `Error: watch job "${id}" not found.`
        return JSON.stringify(job, null, 2)
      }

      default:
        return `Error: Unknown action "${action}"`
    }
  } catch (err: unknown) {
    return `Error: ${getErrorMessage(err)}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const MonitorPlugin: Plugin = {
  name: 'Core Monitor',
  description: 'System observability and durable watch jobs: inspect system state, monitor files/endpoints/tasks, and resume agents when conditions trigger.',
  hooks: {} as PluginHooks,
  tools: [
    {
      name: 'monitor_tool',
      description: 'Observe system health, inspect logs/endpoints, or create durable waits like wait_for_http, wait_for_file, wait_for_webhook, and wait_for_page_change.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['sys_info', 'watch_log', 'ping', 'create_watch', 'wait_until', 'wait_for_http', 'wait_for_file', 'wait_for_task', 'wait_for_webhook', 'wait_for_page_change', 'list_watches', 'get_watch', 'cancel_watch'] },
          target: { type: 'string', description: 'Log file path (for watch_log) or URL (for ping)' },
          limit: { type: 'number', description: 'Number of lines or bytes to retrieve' },
          watchType: { type: 'string', enum: ['time', 'http', 'file', 'task', 'webhook', 'page'] },
          resumeMessage: { type: 'string', description: 'Message injected when the watch triggers and the agent wakes up.' },
          regex: { type: 'string', description: 'Regex pattern used by file/page/http watchers.' },
        },
        required: ['action']
      },
      execute: async (args, context) => executeMonitorAction(args, {
        cwd: context.session.cwd || process.cwd(),
        sessionId: context.session.id,
        agentId: context.session.agentId,
      })
    }
  ]
}

getPluginManager().registerBuiltin('monitor', MonitorPlugin)

export function buildMonitorTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('monitor')) return []
  return [
    tool(
      async (args) => executeMonitorAction(args, {
        cwd: bctx.cwd,
        sessionId: bctx.ctx?.sessionId || undefined,
        agentId: bctx.ctx?.agentId || undefined,
      }),
      {
        name: 'monitor_tool',
        description: MonitorPlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
