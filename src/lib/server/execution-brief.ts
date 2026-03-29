import type {
  EvidenceRef,
  ExecutionBrief,
  ExecutionBriefPlanStep,
  Session,
  SessionWorkingState,
  WorkingPlanStep,
  WorkingStateItemStatus,
  WorkingStateStatus,
} from '@/types'
import { getSession } from '@/lib/server/sessions/session-repository'
import { loadSessionWorkingState } from '@/lib/server/working-state/service'
import { ensureRunContext } from '@/lib/server/run-context'
import { cleanText, cleanMultiline } from '@/lib/server/text-normalization'
import { resolveEffectiveGoal, getGoalChain, formatGoalChainForBrief } from '@/lib/server/goals/goal-service'

const MAX_PLAN_ITEMS = 8
const MAX_FACTS = 8
const MAX_BLOCKERS = 6
const MAX_ARTIFACTS = 6
const MAX_EVIDENCE = 6
const MAX_DELEGATION_PLAN_ITEMS = 4
const MAX_DELEGATION_FACTS = 4
const MAX_DELEGATION_BLOCKERS = 4
const MAX_DELEGATION_ARTIFACTS = 4
const DELEGATION_BUDGET = 1_200

function uniqueStrings(values: Array<unknown>, maxItems: number, maxChars = 240): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const normalized = cleanText(value, maxChars)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
    if (out.length >= maxItems) break
  }
  return out
}

function summarizeArtifact(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const artifact = value as Record<string, unknown>
  return cleanText(artifact.path || artifact.url || artifact.label, 220)
}

function summarizeEvidenceRef(ref: EvidenceRef): string {
  const summary = cleanText(ref.summary, 180)
  if (!summary) return ''
  const value = cleanText(ref.value, 140)
  return value ? `[${ref.type}] ${summary}: ${value}` : `[${ref.type}] ${summary}`
}

function planStatus(step: WorkingPlanStep): WorkingStateItemStatus {
  return step.status === 'resolved' || step.status === 'superseded' ? step.status : 'active'
}

function dedupePlan(steps: ExecutionBriefPlanStep[]): ExecutionBriefPlanStep[] {
  const out: ExecutionBriefPlanStep[] = []
  const seen = new Set<string>()
  for (const step of steps) {
    const text = cleanText(step.text, 240)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      text,
      status: step.status === 'resolved' || step.status === 'superseded' ? step.status : 'active',
    })
    if (out.length >= MAX_PLAN_ITEMS) break
  }
  return out
}

function inferStatus(workingState: SessionWorkingState | null): WorkingStateStatus {
  if (workingState?.status) return workingState.status
  return 'idle'
}

function buildPlan(workingState: SessionWorkingState | null, session: Session | null): ExecutionBriefPlanStep[] {
  if (workingState && Array.isArray(workingState.planSteps) && workingState.planSteps.length > 0) {
    return dedupePlan(
      workingState.planSteps
        .filter((step) => step.status !== 'superseded')
        .map((step) => ({
          text: cleanText(step.text, 240),
          status: planStatus(step),
        })),
    )
  }
  const runContext = session?.runContext ? ensureRunContext(session.runContext) : null
  if (!runContext || !Array.isArray(runContext.currentPlan) || runContext.currentPlan.length === 0) return []
  const completed = new Set((runContext.completedSteps || []).map((value) => cleanText(value, 240).toLowerCase()).filter(Boolean))
  return dedupePlan(
    runContext.currentPlan.map((step) => {
      const text = cleanText(step, 240)
      return {
        text,
        status: completed.has(text.toLowerCase()) ? 'resolved' : 'active',
      }
    }),
  )
}

function buildFacts(workingState: SessionWorkingState | null, session: Session | null): string[] {
  const activeFacts = workingState
    ? workingState.confirmedFacts
      .filter((fact) => fact.status === 'active')
      .map((fact) => fact.statement)
    : []
  const runContextFacts = session?.runContext ? ensureRunContext(session.runContext).keyFacts : []
  return uniqueStrings([...activeFacts, ...runContextFacts], MAX_FACTS, 240)
}

function buildBlockers(workingState: SessionWorkingState | null, session: Session | null): string[] {
  const activeBlockers = workingState
    ? workingState.blockers
      .filter((blocker) => blocker.status === 'active')
      .map((blocker) => blocker.nextAction ? `${blocker.summary} | next: ${blocker.nextAction}` : blocker.summary)
    : []
  const runContextBlockers = session?.runContext ? ensureRunContext(session.runContext).blockers : []
  return uniqueStrings([...activeBlockers, ...runContextBlockers], MAX_BLOCKERS, 280)
}

function buildArtifacts(workingState: SessionWorkingState | null): string[] {
  const artifacts = workingState
    ? workingState.artifacts
      .filter((artifact) => artifact.status === 'active')
      .map((artifact) => summarizeArtifact(artifact))
    : []
  return uniqueStrings(artifacts, MAX_ARTIFACTS, 220)
}

function buildConstraints(workingState: SessionWorkingState | null, session: Session | null): string[] {
  const workingConstraints = workingState?.constraints || []
  const runContext = session?.runContext ? ensureRunContext(session.runContext) : null
  return uniqueStrings([...(workingConstraints || []), ...(runContext?.constraints || [])], 10, 220)
}

function buildSuccessCriteria(workingState: SessionWorkingState | null): string[] {
  return uniqueStrings([...(workingState?.successCriteria || [])], 10, 220)
}

function buildEvidenceRefs(workingState: SessionWorkingState | null): EvidenceRef[] {
  if (!workingState || !Array.isArray(workingState.evidenceRefs) || workingState.evidenceRefs.length === 0) return []
  return [...workingState.evidenceRefs]
    .filter((ref) => Boolean(cleanText(ref.summary, 180)))
    .slice(-MAX_EVIDENCE)
}

export function buildExecutionBrief(params: {
  sessionId?: string | null
  session?: Session | null
  mission?: null
  workingState?: SessionWorkingState | null
}): ExecutionBrief {
  const session = params.session
    || (params.sessionId ? getSession(params.sessionId) || null : null)
  const workingState = params.workingState
    || (session?.id ? loadSessionWorkingState(session.id) : null)
  const runContext = session?.runContext ? ensureRunContext(session.runContext) : null
  const plan = buildPlan(workingState, session)
  const nextAction = cleanText(
    workingState?.nextAction
      || plan.find((step) => step.status === 'active')?.text,
    240,
  ) || null

  return {
    sessionId: session?.id || params.sessionId || null,
    objective: cleanMultiline(
      workingState?.objective
        || runContext?.objective,
      900,
    ) || null,
    summary: cleanMultiline(
      workingState?.summary,
      700,
    ) || null,
    status: inferStatus(workingState),
    nextAction,
    plan,
    blockers: buildBlockers(workingState, session),
    facts: buildFacts(workingState, session),
    artifacts: buildArtifacts(workingState),
    constraints: buildConstraints(workingState, session),
    successCriteria: buildSuccessCriteria(workingState),
    evidenceRefs: buildEvidenceRefs(workingState),
    parentContext: cleanMultiline(runContext?.parentContext, 900) || null,
  }
}

function buildListSection(title: string, values: string[]): string | null {
  if (!values.length) return null
  return [title, ...values.map((value) => `- ${value}`)].join('\n')
}

function formatPlan(plan: ExecutionBriefPlanStep[]): string | null {
  if (!plan.length) return null
  return [
    'Plan',
    ...plan.map((step) => `- [${step.status === 'resolved' ? 'x' : ' '}] ${step.text}`),
  ].join('\n')
}

export function buildExecutionBriefContextBlock(
  brief: ExecutionBrief | null | undefined,
  options?: { title?: string },
): string {
  if (!brief) return ''
  const hasContent = Boolean(
    brief.parentContext
    || brief.objective
    || brief.summary
    || brief.nextAction
    || brief.plan.length > 0
    || brief.blockers.length > 0
    || brief.facts.length > 0
    || brief.artifacts.length > 0
    || brief.constraints.length > 0
    || brief.successCriteria.length > 0
    || brief.evidenceRefs.length > 0,
  )
  if (!hasContent && brief.status === 'idle') return ''
  // Resolve goal chain for the session's agent/task/project context
  let goalBlock = ''
  if (brief.sessionId) {
    const session = getSession(brief.sessionId)
    if (session) {
      const goal = resolveEffectiveGoal({
        agentId: session.agentId || null,
        projectId: session.projectId || null,
      })
      if (goal) {
        const chain = getGoalChain(goal.id)
        goalBlock = formatGoalChainForBrief(chain)
      }
    }
  }

  const sections = [
    options?.title || '## Execution Brief',
    goalBlock,
    brief.parentContext ? `Parent context:\n${brief.parentContext}` : '',
    brief.objective ? `Objective: ${brief.objective}` : '',
    brief.summary ? `Summary: ${brief.summary}` : '',
    `Status: ${brief.status}`,
    brief.nextAction ? `Next action: ${brief.nextAction}` : '',
    brief.successCriteria.length > 0 ? `Success criteria: ${brief.successCriteria.join(' | ')}` : '',
    brief.constraints.length > 0 ? `Constraints: ${brief.constraints.join(' | ')}` : '',
    formatPlan(brief.plan),
    buildListSection('Blockers', brief.blockers),
    buildListSection('Facts', brief.facts),
    buildListSection('Artifacts', brief.artifacts),
    buildListSection('Evidence', brief.evidenceRefs.map((ref) => summarizeEvidenceRef(ref)).filter(Boolean)),
    'Trust this execution brief before reconstructing state from the raw transcript or older assistant text.',
  ].filter(Boolean)
  return sections.join('\n')
}

export function serializeExecutionBriefForDelegation(
  brief: ExecutionBrief | null | undefined,
): string | null {
  if (!brief) return null
  const parts: string[] = []
  let budget = DELEGATION_BUDGET

  const append = (line: string): void => {
    if (!line) return
    if (budget - line.length - 1 < 0) return
    parts.push(line)
    budget -= line.length + 1
  }

  append(brief.objective ? `Objective: ${brief.objective}` : '')
  append(brief.summary ? `Summary: ${cleanText(brief.summary, 280)}` : '')
  append(`Status: ${brief.status}`)
  append(brief.nextAction ? `Next action: ${brief.nextAction}` : '')
  append(brief.successCriteria.length > 0 ? `Success criteria: ${brief.successCriteria.slice(0, 4).join('; ')}` : '')
  append(brief.constraints.length > 0 ? `Constraints: ${brief.constraints.slice(0, 4).join('; ')}` : '')
  append(brief.plan.length > 0 ? `Plan: ${brief.plan.slice(0, MAX_DELEGATION_PLAN_ITEMS).map((step) => step.text).join('; ')}` : '')
  append(brief.blockers.length > 0 ? `Blockers: ${brief.blockers.slice(0, MAX_DELEGATION_BLOCKERS).join('; ')}` : '')
  append(brief.facts.length > 0 ? `Facts: ${brief.facts.slice(0, MAX_DELEGATION_FACTS).join('; ')}` : '')
  append(brief.artifacts.length > 0 ? `Artifacts: ${brief.artifacts.slice(0, MAX_DELEGATION_ARTIFACTS).join('; ')}` : '')
  append(brief.parentContext ? `Parent context: ${cleanText(brief.parentContext, 280)}` : '')
  return parts.length > 0 ? parts.join('\n') : null
}
