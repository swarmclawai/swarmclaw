import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import * as os from 'os'
import type { ToolBuildContext } from './context'
import { getPluginManager } from '../plugins'
import type { Plugin, PluginHooks } from '@/types'
import { safePath, truncate } from './context'
import { normalizeToolInputArgs } from './normalize-tool-args'

/**
 * Unified Monitoring Logic
 */
async function executeMonitorAction(args: any, bctx: { cwd: string }) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const action = normalized.action as string | undefined
  const target = (normalized.target ?? normalized.url ?? normalized.path) as string | undefined
  const limit = normalized.limit as number | undefined
  const threshold = normalized.threshold as number | undefined

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
            url
          }, null, 2)
        } catch (err: any) {
          return JSON.stringify({
            status: 'error',
            error: err.message,
            url
          }, null, 2)
        }
      }

      default:
        return `Error: Unknown action "${action}"`
    }
  } catch (err: any) {
    return `Error: ${err.message}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const MonitorPlugin: Plugin = {
  name: 'Core Monitor',
  description: 'System observability: check resource usage, watch logs, and ping endpoints.',
  hooks: {} as PluginHooks,
  tools: [
    {
      name: 'monitor_tool',
      description: 'Observe system health, log activity, or endpoint availability.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['sys_info', 'watch_log', 'ping'] },
          target: { type: 'string', description: 'Log file path (for watch_log) or URL (for ping)' },
          limit: { type: 'number', description: 'Number of lines or bytes to retrieve' }
        },
        required: ['action']
      },
      execute: async (args, context) => executeMonitorAction(args, { cwd: context.session.cwd || process.cwd() })
    }
  ]
}

getPluginManager().registerBuiltin('monitor', MonitorPlugin)

export function buildMonitorTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('monitor')) return []
  return [
    tool(
      async (args) => executeMonitorAction(args, { cwd: bctx.cwd }),
      {
        name: 'monitor_tool',
        description: MonitorPlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
