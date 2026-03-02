import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { loadSessions, saveSessions } from '../storage'
import { notify } from '../ws-hub'
import type { ToolBuildContext } from './context'

export function buildCanvasTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const { ctx, hasTool } = bctx
  if (!hasTool('canvas')) return []

  return [
    tool(
      async ({ action, content }) => {
        try {
          const sessionId = ctx?.sessionId
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

          return `Unknown canvas action "${action}". Valid: present, hide, snapshot`
        } catch (err: unknown) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      },
      {
        name: 'canvas',
        description: 'Present live HTML/CSS/JS content to the user in an interactive canvas panel. Use "present" to show content, "hide" to dismiss, "snapshot" to check current state. The canvas renders in a sandboxed iframe alongside the chat.',
        schema: z.object({
          action: z.enum(['present', 'hide', 'snapshot']).describe('Canvas action to perform'),
          content: z.string().optional().describe('HTML content to render (required for "present"). Can include inline CSS and JS.'),
        }),
      },
    ),
  ]
}
