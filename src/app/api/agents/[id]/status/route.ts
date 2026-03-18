import { NextResponse } from 'next/server'
import { getAgentStatus } from '@/lib/server/agents/agent-service'
import { getMainLoopStateForSession } from '@/lib/server/agents/main-agent-loop'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const agent = getAgentStatus(id)
  if (!agent) return NextResponse.json(null, { status: 404 })

  const sessionId = agent.threadSessionId
  if (!sessionId) return NextResponse.json({ status: 'no_session' }, { status: 200 })

  const state = getMainLoopStateForSession(sessionId)
  if (!state) return NextResponse.json({ status: 'no_state' }, { status: 200 })

  return NextResponse.json({
    goal: state.goal,
    status: state.status,
    summary: state.summary,
    nextAction: state.nextAction,
    planSteps: state.planSteps,
    currentPlanStep: state.currentPlanStep,
    updatedAt: state.updatedAt,
  })
}
