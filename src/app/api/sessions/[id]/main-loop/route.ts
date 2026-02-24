import { NextResponse } from 'next/server'
import { enqueueSessionRun } from '@/lib/server/session-run-manager'
import { loadSessions } from '@/lib/server/storage'
import {
  buildMainLoopHeartbeatPrompt,
  getMainLoopStateForSession,
  isMainSession,
  pushMainLoopEventToMainSessions,
  setMainLoopStateForSession,
} from '@/lib/server/main-agent-loop'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sessions = loadSessions()
  const session = sessions[id]
  if (!session) return new NextResponse('Session not found', { status: 404 })
  if (!isMainSession(session)) return new NextResponse('Main-loop controls only apply to __main__ sessions', { status: 400 })
  const state = getMainLoopStateForSession(id)
  return NextResponse.json({ sessionId: id, state })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const action = typeof body.action === 'string' ? body.action.trim() : ''

  const sessions = loadSessions()
  const session = sessions[id]
  if (!session) return new NextResponse('Session not found', { status: 404 })
  if (!isMainSession(session)) return new NextResponse('Main-loop controls only apply to __main__ sessions', { status: 400 })

  if (action === 'pause') {
    const state = setMainLoopStateForSession(id, { paused: true })
    return NextResponse.json({ ok: true, action, state })
  }

  if (action === 'resume') {
    const state = setMainLoopStateForSession(id, { paused: false })
    return NextResponse.json({ ok: true, action, state })
  }

  if (action === 'set_goal') {
    const goal = typeof body.goal === 'string' ? body.goal.trim() : ''
    if (!goal) return new NextResponse('goal is required for set_goal', { status: 400 })
    const state = setMainLoopStateForSession(id, {
      goal,
      status: 'progress',
      paused: false,
      followupChainCount: 0,
    })
    pushMainLoopEventToMainSessions({
      type: 'operator_goal',
      text: `Operator set mission goal: ${goal}`,
      user: session.user || null,
    })
    return NextResponse.json({ ok: true, action, state })
  }

  if (action === 'set_mode') {
    const mode = body.mode === 'assist' ? 'assist' : body.mode === 'autonomous' ? 'autonomous' : null
    if (!mode) return new NextResponse('mode must be "assist" or "autonomous"', { status: 400 })
    const state = setMainLoopStateForSession(id, { autonomyMode: mode })
    return NextResponse.json({ ok: true, action, state })
  }

  if (action === 'clear_events') {
    const state = setMainLoopStateForSession(id, { pendingEvents: [] })
    return NextResponse.json({ ok: true, action, state })
  }

  if (action === 'nudge') {
    const state = getMainLoopStateForSession(id)
    if (state?.paused) {
      return new NextResponse('Mission loop is paused; resume first', { status: 409 })
    }
    const note = typeof body.note === 'string' ? body.note.trim() : ''
    const prompt = buildMainLoopHeartbeatPrompt(
      session,
      'Operator requested manual nudge: execute one concrete next step now and report concise progress.',
    )
    const message = note ? `${prompt}\nOperator note: ${note.slice(0, 500)}` : prompt
    const run = enqueueSessionRun({
      sessionId: id,
      message,
      internal: true,
      source: 'mission-control',
      mode: 'collect',
      dedupeKey: `mission-control:nudge:${id}`,
    })
    return NextResponse.json({ ok: true, action, runId: run.runId, position: run.position, deduped: run.deduped || false, state })
  }

  return new NextResponse('Unknown action. Use pause, resume, set_goal, set_mode, clear_events, or nudge.', { status: 400 })
}
