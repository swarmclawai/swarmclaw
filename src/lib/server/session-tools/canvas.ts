import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { loadSessions, saveSessions } from '../storage'
import { notify } from '../ws-hub'
import type { ToolBuildContext } from './context'
import type { Plugin, PluginHooks } from '@/types'
import { registerNativeCapability } from '../native-capabilities'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { normalizeCanvasContent, summarizeCanvasContent } from '@/lib/canvas-content'
import { errorMessage } from '@/lib/shared-utils'

/**
 * Core Canvas Execution Logic
 */
async function executeCanvasAction(args: Record<string, unknown>, context: { sessionId?: string }) {
  const normalized = normalizeToolInputArgs(args)
  const action = normalized.action as string
  const content = normalized.content as string | undefined
  const document = normalized.document
  try {
    const sessionId = context.sessionId
    if (!sessionId) return 'Error: no active session for canvas.'

    const sessions = loadSessions()
    const session = sessions[sessionId]
    if (!session) return 'Error: session not found.'

    if (action === 'present') {
      const nextContent = normalizeCanvasContent(document ?? content)
      if (!nextContent) return 'Error: content or document is required for present action.'
      ;(session as unknown as Record<string, unknown>).canvasContent = nextContent
      session.lastActiveAt = Date.now()
      sessions[sessionId] = session
      saveSessions(sessions)
      notify(`canvas:${sessionId}`)
      return JSON.stringify({
        ok: true,
        action: 'present',
        ...summarizeCanvasContent(nextContent),
      })
    }

    if (action === 'hide') {
      ;(session as unknown as Record<string, unknown>).canvasContent = null
      session.lastActiveAt = Date.now()
      sessions[sessionId] = session
      saveSessions(sessions)
      notify(`canvas:${sessionId}`)
      return JSON.stringify({ ok: true, action: 'hide' })
    }

    if (action === 'snapshot') {
      const current = normalizeCanvasContent((session as unknown as Record<string, unknown>).canvasContent)
      return JSON.stringify({ ok: true, action: 'snapshot', ...summarizeCanvasContent(current) })
    }

    return `Unknown canvas action "${action}".`
  } catch (err: unknown) {
    return `Error: ${errorMessage(err)}`
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
          content: { type: 'string' },
          document: { type: 'object', additionalProperties: true },
        },
        required: ['action']
      },
      execute: async (args, context) => executeCanvasAction(args, { sessionId: context.session.id })
    }
  ]
}

registerNativeCapability('canvas', CanvasPlugin)

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
