import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { loadSessions, saveSessions } from '../storage'
import { notify } from '../ws-hub'
import type { ToolBuildContext } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { getPluginManager } from '../plugins'
import { normalizeToolInputArgs } from './normalize-tool-args'

/**
 * Core Canvas Execution Logic
 */
async function executeCanvasAction(args: Record<string, unknown>, context: { sessionId?: string }) {
  const normalized = normalizeToolInputArgs(args)
  const action = normalized.action as string
  const content = normalized.content as string | undefined
  try {
    const sessionId = context.sessionId
    if (!sessionId) return 'Error: no active session for canvas.'

    const sessions = loadSessions()
    const session = sessions[sessionId]
    if (!session) return 'Error: session not found.'

    if (action === 'present') {
      if (!content) return 'Error: content is required for present action.'
      ;(session as Record<string, unknown>).canvasContent = content
      session.lastActiveAt = Date.now()
      sessions[sessionId] = session
      saveSessions(sessions)
      notify(`canvas:${sessionId}`)
      return JSON.stringify({ ok: true, action: 'present', contentLength: content.length })
    }

    if (action === 'hide') {
      ;(session as Record<string, unknown>).canvasContent = null
      session.lastActiveAt = Date.now()
      sessions[sessionId] = session
      saveSessions(sessions)
      notify(`canvas:${sessionId}`)
      return JSON.stringify({ ok: true, action: 'hide' })
    }

    if (action === 'snapshot') {
      const current = (session as Record<string, unknown>).canvasContent
      return JSON.stringify({
        ok: true,
        action: 'snapshot',
        hasContent: !!current,
        contentLength: typeof current === 'string' ? current.length : 0,
        preview: typeof current === 'string' ? current.slice(0, 500) : null,
      })
    }

    return `Unknown canvas action "${action}".`
  } catch (err: unknown) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Register as a Built-in Plugin
 */
const CanvasPlugin: Plugin = {
  name: 'Core Canvas',
  description: 'Present live HTML/CSS/JS content to the user in an interactive canvas panel.',
  hooks: {} as PluginHooks,
  tools: [
    {
      name: 'canvas',
      description: 'Interact with the live canvas panel.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['present', 'hide', 'snapshot'] },
          content: { type: 'string' }
        },
        required: ['action']
      },
      execute: async (args, context) => executeCanvasAction(args, { sessionId: context.session.id })
    }
  ]
}

getPluginManager().registerBuiltin('canvas', CanvasPlugin)

/**
 * Legacy Bridge
 */
export function buildCanvasTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasPlugin('canvas')) return []
  return [
    tool(
      async (args) => executeCanvasAction(args, { sessionId: bctx.ctx?.sessionId || undefined }),
      {
        name: 'canvas',
        description: CanvasPlugin.tools![0].description,
        schema: z.object({}).passthrough()
      }
    )
  ]
}
