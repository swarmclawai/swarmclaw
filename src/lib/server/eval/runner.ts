import fs from 'node:fs'
import path from 'node:path'
import { genId } from '@/lib/id'
import type { EvalScenario, EvalRun, EvalSuiteResult } from './types'
import { getScenario, EVAL_SCENARIOS } from './scenarios'
import { scoreCriteria } from './scorer'
import { saveEvalRun } from './store'
import { loadSessions, saveSessions, loadAgents, loadCredentials, decryptKey } from '../storage'
import { executeExecutionChatTurn } from '@/lib/server/execution-engine/chat-turn'
import { WORKSPACE_DIR } from '../data-dir'
import type { Session } from '@/types'
import { errorMessage } from '@/lib/shared-utils'

export function resolveEvalSessionCwd(runId: string): string {
  const dir = path.join(WORKSPACE_DIR, 'evals', runId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export async function runEvalScenario(scenarioId: string, agentId: string): Promise<EvalRun> {
  const scenario = getScenario(scenarioId)
  if (!scenario) throw new Error(`Unknown eval scenario: ${scenarioId}`)

  const agents = loadAgents() as unknown as Record<string, Record<string, unknown>>
  const agent = agents[agentId]
  if (!agent) throw new Error(`Unknown agent: ${agentId}`)

  const runId = genId()
  const sessionId = `eval-${runId}`
  const now = Date.now()
  const sessionCwd = resolveEvalSessionCwd(runId)

  const run: EvalRun = {
    id: runId,
    scenarioId,
    agentId,
    status: 'running',
    startedAt: now,
    score: 0,
    maxScore: scenario.scoringCriteria.reduce((sum, c) => sum + c.weight, 0),
    details: [],
    sessionId,
  }

  // Create temporary eval session
  const sessions = loadSessions() as Record<string, Session>
  const evalSession: Session = {
    id: sessionId,
    name: `Eval: ${scenario.name}`,
    cwd: sessionCwd,
    user: 'eval-runner',
    provider: (agent.provider as Session['provider']) ?? 'anthropic',
    model: (agent.model as string) ?? '',
    credentialId: (agent.credentialId as string | null) ?? null,
    apiEndpoint: (agent.apiEndpoint as string | null) ?? null,
    claudeSessionId: null,
    agentId,
    tools: scenario.tools,
    messages: [],
    createdAt: now,
    lastActiveAt: now,
  }
  sessions[sessionId] = evalSession
  saveSessions(sessions)

  try {
    const result = await executeExecutionChatTurn({
      sessionId,
      message: scenario.userMessage,
      internal: true,
      source: 'eval',
    })

    const judgeProvider = typeof agent.provider === 'string' ? agent.provider : undefined
    const judgeModel = typeof agent.model === 'string' ? agent.model : undefined
    let judgeApiKey: string | null = null
    if (typeof agent.credentialId === 'string' && agent.credentialId) {
      const creds = loadCredentials()
      const cred = creds[agent.credentialId]
      if (cred) {
        try { judgeApiKey = decryptKey(cred.encryptedKey) } catch { /* skip undecryptable */ }
      }
    }
    const judgeOpts = judgeProvider && judgeModel ? {
      provider: judgeProvider,
      model: judgeModel,
      apiKey: judgeApiKey,
      apiEndpoint: typeof agent.apiEndpoint === 'string' ? agent.apiEndpoint : undefined,
    } : undefined

    run.details = await scoreCriteria(
      scenario.scoringCriteria,
      result.text,
      result.toolEvents || [],
      judgeOpts,
    )
    run.score = run.details.reduce((sum, d) => sum + d.score, 0)
    run.status = 'completed'
    run.endedAt = Date.now()
  } catch (err: unknown) {
    run.status = 'failed'
    run.error = errorMessage(err)
    run.endedAt = Date.now()
  } finally {
    // Clean up eval session
    const currentSessions = loadSessions() as Record<string, Session>
    delete currentSessions[sessionId]
    saveSessions(currentSessions)
  }

  saveEvalRun(run)
  return run
}

export async function runEvalSuite(agentId: string, categories?: string[]): Promise<EvalSuiteResult> {
  const scenarios: EvalScenario[] = categories
    ? EVAL_SCENARIOS.filter(s => categories.includes(s.category))
    : EVAL_SCENARIOS

  const runs: EvalRun[] = []
  for (const scenario of scenarios) {
    const evalRun = await runEvalScenario(scenario.id, agentId)
    runs.push(evalRun)
  }

  const totalScore = runs.reduce((sum, r) => sum + r.score, 0)
  const maxScore = runs.reduce((sum, r) => sum + r.maxScore, 0)

  return {
    agentId,
    totalScore,
    maxScore,
    percentage: maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0,
    runs,
    completedAt: Date.now(),
  }
}
