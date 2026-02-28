import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import crypto from 'crypto'
import { loadSessions, saveSessions, loadAgents } from '../storage'
import type { ToolBuildContext } from './context'

export function buildSessionInfoTools(bctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = []
  const { cwd, ctx } = bctx

  if (bctx.hasTool('manage_sessions')) {
    tools.push(
      tool(
        async () => {
          try {
            const sessions = loadSessions()
            const current = ctx?.sessionId ? sessions[ctx.sessionId] : null
            return JSON.stringify({
              sessionId: ctx?.sessionId || null,
              sessionName: current?.name || null,
              sessionType: current?.sessionType || null,
              user: current?.user || null,
              agentId: ctx?.agentId || current?.agentId || null,
              parentSessionId: current?.parentSessionId || null,
              heartbeatEnabled: typeof current?.heartbeatEnabled === 'boolean'
                ? current.heartbeatEnabled
                : null,
            })
          } catch (err: any) {
            return `Error: ${err.message || String(err)}`
          }
        },
        {
          name: 'whoami_tool',
          description: 'Return identity/runtime context for this agent execution (current session id, agent id, session owner, and parent session).',
          schema: z.object({}),
        },
      ),
    )

    tools.push(
      tool(
        async ({ action, sessionId, message, limit, agentId, name, waitForReply, timeoutSec, queueMode, heartbeatEnabled, heartbeatIntervalSec, heartbeatIntervalMs, finalStatus, envelopeId, type, correlationId, ttlSec }) => {
          try {
            const sessions = loadSessions()
            if (action === 'list') {
              const { getSessionRunState } = await import('../session-run-manager')
              const items = Object.values(sessions)
                .sort((a: any, b: any) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
                .slice(0, Math.max(1, Math.min(limit || 50, 200)))
                .map((s: any) => {
                  const runState = getSessionRunState(s.id)
                  return {
                    id: s.id,
                    name: s.name,
                    sessionType: s.sessionType || 'human',
                    agentId: s.agentId || null,
                    provider: s.provider,
                    model: s.model,
                    parentSessionId: s.parentSessionId || null,
                    active: !!runState.runningRunId,
                    queuedCount: runState.queueLength,
                    heartbeatEnabled: s.heartbeatEnabled !== false,
                    lastActiveAt: s.lastActiveAt,
                    createdAt: s.createdAt,
                  }
                })
              return JSON.stringify(items)
            }

            if (action === 'history') {
              const targetSessionId = sessionId || ctx?.sessionId || null
              if (!targetSessionId) return 'Error: sessionId is required for history when no current session context exists.'
              const target = sessions[targetSessionId]
              if (!target) return `Not found: session "${targetSessionId}"`
              const max = Math.max(1, Math.min(limit || 20, 100))
              const history = (target.messages || []).slice(-max).map((m: any) => ({
                role: m.role,
                text: m.text,
                time: m.time,
                kind: m.kind || 'chat',
              }))
              return JSON.stringify({ sessionId: target.id, name: target.name, history, currentSessionDefaulted: !sessionId })
            }

            if (action === 'status') {
              if (!sessionId) return 'Error: sessionId is required for status.'
              const target = sessions[sessionId]
              if (!target) return `Not found: session "${sessionId}"`
              const { getSessionRunState } = await import('../session-run-manager')
              const run = getSessionRunState(sessionId)
              return JSON.stringify({
                id: target.id,
                name: target.name,
                runningRunId: run.runningRunId || null,
                queuedCount: run.queueLength,
                heartbeatEnabled: target.heartbeatEnabled !== false,
                lastActiveAt: target.lastActiveAt,
                messageCount: (target.messages || []).length,
              })
            }

            if (action === 'stop') {
              if (!sessionId) return 'Error: sessionId is required for stop.'
              if (!sessions[sessionId]) return `Not found: session "${sessionId}"`
              const { cancelSessionRuns } = await import('../session-run-manager')
              const out = cancelSessionRuns(sessionId, 'Stopped by manage_sessions')
              return JSON.stringify({ sessionId, ...out })
            }

            if (action === 'send') {
              if (!sessionId) return 'Error: sessionId is required for send.'
              if (!message?.trim()) return 'Error: message is required for send.'
              if (!sessions[sessionId]) return `Not found: session "${sessionId}"`
              if (ctx?.sessionId && sessionId === ctx.sessionId) return 'Error: cannot send to the current session itself.'

              const sourceSession = ctx?.sessionId ? sessions[ctx.sessionId] : null
              const sourceLabel = sourceSession
                ? `${sourceSession.name} (${sourceSession.id})`
                : (ctx?.agentId ? `agent:${ctx.agentId}` : 'platform')
              const bridgedMessage = `[Session message from ${sourceLabel}]\n${message.trim()}`

              const { enqueueSessionRun } = await import('../session-run-manager')
              const mode = queueMode === 'steer' || queueMode === 'collect' || queueMode === 'followup'
                ? queueMode
                : 'followup'
              const run = enqueueSessionRun({
                sessionId,
                message: bridgedMessage,
                source: 'session-send',
                internal: false,
                mode,
              })

              if (waitForReply === false) {
                return JSON.stringify({
                  sessionId,
                  runId: run.runId,
                  status: 'queued',
                  mode,
                })
              }

              const timeoutMs = Math.max(5, Math.min(timeoutSec || 120, 900)) * 1000
              const result = await Promise.race([
                run.promise,
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`Timed out waiting for session reply after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs),
                ),
              ])
              return JSON.stringify({
                sessionId,
                runId: run.runId,
                status: result.error ? 'failed' : 'completed',
                reply: result.text || '',
                error: result.error || null,
              })
            }

            if (action === 'spawn') {
              if (!agentId) return 'Error: agentId is required for spawn.'
              const agents = loadAgents()
              const agent = agents[agentId]
              if (!agent) return `Not found: agent "${agentId}"`
              const sourceSession = ctx?.sessionId ? sessions[ctx.sessionId] : null
              const ownerUser = sourceSession?.user || 'system'

              const id = crypto.randomBytes(4).toString('hex')
              const now = Date.now()
              const entry = {
                id,
                name: (name || `${agent.name} Session`).trim(),
                cwd,
                user: ownerUser,
                provider: agent.provider || 'claude-cli',
                model: agent.model || '',
                credentialId: agent.credentialId || null,
                apiEndpoint: agent.apiEndpoint || null,
                claudeSessionId: null,
                codexThreadId: null,
                opencodeSessionId: null,
                delegateResumeIds: {
                  claudeCode: null,
                  codex: null,
                  opencode: null,
                },
                messages: [],
                createdAt: now,
                lastActiveAt: now,
                sessionType: 'orchestrated',
                agentId: agent.id,
                parentSessionId: ctx?.sessionId || null,
                tools: agent.tools || [],
                heartbeatEnabled: agent.heartbeatEnabled ?? true,
                heartbeatIntervalSec: agent.heartbeatIntervalSec ?? null,
              }
              sessions[id] = entry as any
              saveSessions(sessions)

              let runId: string | null = null
              if (message?.trim()) {
                const { enqueueSessionRun } = await import('../session-run-manager')
                const run = enqueueSessionRun({
                  sessionId: id,
                  message: message.trim(),
                  source: 'session-spawn',
                  internal: false,
                  mode: 'followup',
                })
                runId = run.runId
              }

              return JSON.stringify({
                sessionId: id,
                name: entry.name,
                agentId: agent.id,
                queuedRunId: runId,
              })
            }

            if (action === 'set_heartbeat') {
              const targetSessionId = sessionId || ctx?.sessionId || null
              if (!targetSessionId) return 'Error: sessionId is required when no current session context exists.'
              const target = sessions[targetSessionId]
              if (!target) return `Not found: session "${targetSessionId}"`
              const intervalFromMs = typeof heartbeatIntervalMs === 'number'
                ? Math.max(0, Math.round(heartbeatIntervalMs / 1000))
                : undefined
              const nextIntervalSecRaw = typeof heartbeatIntervalSec === 'number'
                ? heartbeatIntervalSec
                : intervalFromMs
              const nextIntervalSec = typeof nextIntervalSecRaw === 'number'
                ? Math.max(0, Math.min(3600, Math.round(nextIntervalSecRaw)))
                : undefined

              if (typeof heartbeatEnabled !== 'boolean' && typeof nextIntervalSec !== 'number') {
                return 'Error: set_heartbeat requires heartbeatEnabled and/or heartbeatIntervalSec/heartbeatIntervalMs.'
              }

              if (typeof heartbeatEnabled === 'boolean') target.heartbeatEnabled = heartbeatEnabled
              if (typeof nextIntervalSec === 'number') target.heartbeatIntervalSec = nextIntervalSec
              target.lastActiveAt = Date.now()

              let statusMessageAdded = false
              if (target.heartbeatEnabled === false && finalStatus?.trim()) {
                if (!Array.isArray(target.messages)) target.messages = []
                target.messages.push({
                  role: 'assistant',
                  text: finalStatus.trim(),
                  time: Date.now(),
                  kind: 'heartbeat',
                })
                statusMessageAdded = true
              }

              saveSessions(sessions)
              return JSON.stringify({
                sessionId: targetSessionId,
                heartbeatEnabled: target.heartbeatEnabled !== false,
                heartbeatIntervalSec: target.heartbeatIntervalSec ?? null,
                heartbeatIntervalMs: typeof target.heartbeatIntervalSec === 'number' ? target.heartbeatIntervalSec * 1000 : null,
                statusMessageAdded,
              })
            }

            if (action === 'mailbox_send') {
              if (!sessionId) return 'Error: sessionId (target session) is required for mailbox_send.'
              if (!message?.trim()) return 'Error: message is required for mailbox_send.'
              const { sendMailboxEnvelope } = await import('../session-mailbox')
              const envelope = sendMailboxEnvelope({
                toSessionId: sessionId,
                type: type?.trim() || 'message',
                payload: message.trim(),
                fromSessionId: ctx?.sessionId || null,
                fromAgentId: ctx?.agentId || null,
                correlationId: correlationId?.trim() || null,
                ttlSec: typeof ttlSec === 'number' ? ttlSec : null,
              })
              return JSON.stringify({ ok: true, envelope })
            }

            if (action === 'mailbox_inbox') {
              const targetSessionId = sessionId || ctx?.sessionId || null
              if (!targetSessionId) return 'Error: sessionId is required for mailbox_inbox when no current session context exists.'
              const { listMailbox } = await import('../session-mailbox')
              const envelopes = listMailbox(targetSessionId, { limit, includeAcked: false })
              return JSON.stringify({
                sessionId: targetSessionId,
                count: envelopes.length,
                envelopes,
                currentSessionDefaulted: !sessionId,
              })
            }

            if (action === 'mailbox_ack') {
              const targetSessionId = sessionId || ctx?.sessionId || null
              if (!targetSessionId) return 'Error: sessionId is required for mailbox_ack when no current session context exists.'
              if (!envelopeId?.trim()) return 'Error: envelopeId is required for mailbox_ack.'
              const { ackMailboxEnvelope } = await import('../session-mailbox')
              const envelope = ackMailboxEnvelope(targetSessionId, envelopeId.trim())
              if (!envelope) return `Not found: envelope "${envelopeId.trim()}"`
              return JSON.stringify({ ok: true, envelope })
            }

            if (action === 'mailbox_clear') {
              const targetSessionId = sessionId || ctx?.sessionId || null
              if (!targetSessionId) return 'Error: sessionId is required for mailbox_clear when no current session context exists.'
              const { clearMailbox } = await import('../session-mailbox')
              const cleared = clearMailbox(targetSessionId, true)
              return JSON.stringify({ ok: true, ...cleared })
            }

            return 'Unknown action. Use list, history, status, send, spawn, stop, set_heartbeat, mailbox_send, mailbox_inbox, mailbox_ack, or mailbox_clear.'
          } catch (err: any) {
            return `Error: ${err.message || String(err)}`
          }
        },
        {
          name: 'sessions_tool',
          description: 'Session-to-session operations: list/status/history sessions, send messages to other sessions, spawn new agent sessions, stop active runs, control per-session heartbeat, and exchange protocol envelopes via mailbox_* actions.',
          schema: z.object({
            action: z.enum(['list', 'history', 'status', 'send', 'spawn', 'stop', 'set_heartbeat', 'mailbox_send', 'mailbox_inbox', 'mailbox_ack', 'mailbox_clear']).describe('Session action'),
            sessionId: z.string().optional().describe('Target session id (history defaults to current session when omitted; status/send/stop still require explicit sessionId)'),
            message: z.string().optional().describe('Message body (required for send, optional initial task for spawn)'),
            limit: z.number().optional().describe('Max items/messages for list/history'),
            agentId: z.string().optional().describe('Agent id to spawn (required for spawn)'),
            name: z.string().optional().describe('Optional session name for spawn'),
            waitForReply: z.boolean().optional().describe('For send: if false, queue and return immediately'),
            timeoutSec: z.number().optional().describe('For send with waitForReply=true, max wait time in seconds (default 120)'),
            queueMode: z.enum(['followup', 'steer', 'collect']).optional().describe('Queue mode for send'),
            heartbeatEnabled: z.boolean().optional().describe('For set_heartbeat: true to enable heartbeat, false to disable'),
            heartbeatIntervalSec: z.number().optional().describe('For set_heartbeat: optional heartbeat interval in seconds (0-3600).'),
            heartbeatIntervalMs: z.number().optional().describe('For set_heartbeat: optional heartbeat interval in milliseconds (alias of heartbeatIntervalSec).'),
            finalStatus: z.string().optional().describe('For set_heartbeat when disabling: optional final status update to append in the session'),
            envelopeId: z.string().optional().describe('For mailbox_ack: envelope id to acknowledge.'),
            type: z.string().optional().describe('For mailbox_send: protocol message type (default "message").'),
            correlationId: z.string().optional().describe('For mailbox_send: optional request/response correlation id.'),
            ttlSec: z.number().optional().describe('For mailbox_send: optional envelope TTL in seconds.'),
          }),
        },
      ),
    )

    tools.push(
      tool(
        async ({ query, sessionId, limit, dateRange }) => {
          try {
            const sessions = loadSessions()
            const targetSessionId = sessionId || ctx?.sessionId || null
            if (!targetSessionId) return 'Error: sessionId is required when no current session context exists.'
            const target = sessions[targetSessionId]
            if (!target) return `Not found: session "${targetSessionId}"`

            const from = typeof dateRange?.from === 'number' ? dateRange.from : Number.NEGATIVE_INFINITY
            const to = typeof dateRange?.to === 'number' ? dateRange.to : Number.POSITIVE_INFINITY
            const max = Math.max(1, Math.min(limit || 20, 200))
            const q = (query || '').trim().toLowerCase()
            const terms = q ? q.split(/\s+/).filter(Boolean) : []

            const scoredAll = (target.messages || [])
              .map((m: any, idx: number) => ({ ...m, _idx: idx }))
              .filter((m: any) => {
                const t = typeof m.time === 'number' ? m.time : 0
                if (t < from || t > to) return false
                if (!terms.length) return true
                const hay = `${m.role || ''}\n${m.kind || ''}\n${m.text || ''}`.toLowerCase()
                return terms.every((term) => hay.includes(term))
              })
              .map((m: any) => {
                const hay = `${m.text || ''}`.toLowerCase()
                let score = 0
                if (q && hay.includes(q)) score += 5
                for (const term of terms) {
                  if (hay.includes(term)) score += 1
                }
                const ageBoost = Math.max(0, (m.time || 0) / 1e13)
                score += ageBoost
                return { ...m, _score: score }
              })
              .sort((a: any, b: any) => b._score - a._score)
            const scored = scoredAll
              .slice(0, max)
              .map((m: any) => ({
                index: m._idx,
                role: m.role,
                kind: m.kind || 'chat',
                time: m.time,
                text: typeof m.text === 'string' && m.text.length > 1200 ? `${m.text.slice(0, 1200)}...` : (m.text || ''),
              }))

            return JSON.stringify({
              sessionId: target.id,
              name: target.name,
              query: query || '',
              limit: max,
              matches: scored,
              totalMatches: scoredAll.length,
              currentSessionDefaulted: !sessionId,
            })
          } catch (err: any) {
            return `Error: ${err.message || String(err)}`
          }
        },
        {
          name: 'search_history_tool',
          description: 'Search message history for the current session by default, or another session if sessionId is provided. Useful for recalling prior commitments, decisions, and details.',
          schema: z.object({
            query: z.string().describe('Search query text (keywords, phrase, or topic).'),
            sessionId: z.string().optional().describe('Optional target session id; defaults to current session.'),
            limit: z.number().optional().describe('Maximum number of matches to return (default 20, max 200).'),
            dateRange: z.object({
              from: z.number().optional().describe('Unix epoch ms lower bound (inclusive).'),
              to: z.number().optional().describe('Unix epoch ms upper bound (inclusive).'),
            }).optional().describe('Optional time filter for message timestamps.'),
          }),
        },
      ),
    )
  }

  return tools
}
