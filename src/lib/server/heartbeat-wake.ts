/**
 * On-demand heartbeat wake — triggers an immediate heartbeat for an agent/session.
 * Requests are debounced with a 250ms coalesce window to batch rapid-fire events.
 */

import { ensureAgentThreadSession } from './agent-thread-session'
import { loadSessions, loadAgents, loadSettings } from './storage'
import { enqueueSessionRun } from './session-run-manager'
import { log } from './logger'

interface WakeRequest {
  agentId?: string
  sessionId?: string
  reason?: string
}

const COALESCE_MS = 250

const globalKey = '__swarmclaw_heartbeat_wake__' as const
const globalScope = globalThis as typeof globalThis & {
  [globalKey]?: { pending: Map<string, WakeRequest>; timer: ReturnType<typeof setTimeout> | null }
}
const state = globalScope[globalKey] ?? (globalScope[globalKey] = {
  pending: new Map(),
  timer: null,
})

function flushWakes(): void {
  state.timer = null
  const wakes = new Map(state.pending)
  state.pending.clear()

  const agents = loadAgents()
  const settings = loadSettings()

  for (const [_key, wake] of wakes) {
    try {
      let sessionId = wake.sessionId

      // If only agentId provided, find the agent's most recently active session
      if (!sessionId && wake.agentId) {
        const sessions = loadSessions()
        let bestSession: { id: string; lastActiveAt: number } | null = null
        for (const s of Object.values(sessions) as Array<Record<string, unknown>>) {
          if (s.agentId !== wake.agentId) continue
          const lastActive = typeof s.lastActiveAt === 'number' ? s.lastActiveAt : 0
          if (!bestSession || lastActive > bestSession.lastActiveAt) {
            bestSession = { id: s.id as string, lastActiveAt: lastActive }
          }
        }
        sessionId = bestSession?.id
        if (!sessionId) {
          sessionId = ensureAgentThreadSession(wake.agentId)?.id
        }
      }

      if (!sessionId) continue

      const session = loadSessions()[sessionId] as Record<string, unknown> | undefined
      if (!session) continue

      const agentId = (session.agentId || wake.agentId) as string | undefined
      const agent = agentId ? agents[agentId] : null

      // Build a minimal heartbeat prompt for the wake
      const reason = wake.reason || 'on-demand'
      const prompt = [
        'AGENT_HEARTBEAT_WAKE',
        `Time: ${new Date().toISOString()}`,
        agent ? `Agent: ${(agent as Record<string, unknown>).name}` : '',
        `Wake reason: ${reason}`,
        '',
        'An event has occurred that may require your attention.',
        'Review and take appropriate action, or reply HEARTBEAT_OK if nothing is needed.',
      ].filter(Boolean).join('\n')

      // Resolve heartbeat model from agent/settings
      const heartbeatModel =
        (agent as Record<string, unknown> | null)?.heartbeatModel as string | undefined
        || settings.heartbeatModel as string | undefined
        || undefined

      enqueueSessionRun({
        sessionId,
        message: prompt,
        internal: true,
        source: 'heartbeat-wake',
        mode: 'collect',
        dedupeKey: `heartbeat-wake:${sessionId}`,
        modelOverride: heartbeatModel,
        heartbeatConfig: {
          ackMaxChars: 300,
          showOk: false,
          showAlerts: true,
          target: null,
        },
      })

      log.info('heartbeat-wake', `Wake fired for session ${sessionId} (reason: ${reason})`)
    } catch (err: unknown) {
      log.warn('heartbeat-wake', `Wake failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** Queue a heartbeat wake. Multiple rapid calls are coalesced into a single flush. */
export function requestHeartbeatNow(opts: WakeRequest): void {
  const key = opts.agentId || opts.sessionId || 'unknown'
  state.pending.set(key, opts)

  if (!state.timer) {
    state.timer = setTimeout(flushWakes, COALESCE_MS)
  }
}
