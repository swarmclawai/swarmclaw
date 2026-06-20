import { checkAgentBudgetLimits } from '@/lib/server/cost'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { log } from '@/lib/server/logger'
import { loadSettings } from '@/lib/server/settings/settings-repository'
import { loadSessions } from '@/lib/server/sessions/session-repository'
import { appendPersistedRunEvent, buildRetrievalSummary, persistRun } from '@/lib/server/runtime/run-ledger'
import { notify } from '@/lib/server/ws-hub'
import { captureGuardianCheckpoint } from '@/lib/server/agents/guardian'
import {
  assessAutonomyRun,
  executeSupervisorAutoActions,
} from '@/lib/server/autonomy/supervisor-reflection'
import { errorMessage, hmrSingleton } from '@/lib/shared-utils'
import type {
  Agent,
  BoardTask,
  KnowledgeCitation,
  KnowledgeRetrievalTrace,
  KnowledgeSourceKind,
  MemoryEntry,
  Session,
  SessionRunRecord,
  SessionRunStatus,
} from '@/types'
import type { ExecuteChatTurnResult } from '@/lib/server/chat-execution/chat-execution-types'
import type {
  EnqueueTaskAttemptExecutionRequest,
  ExecutionHandle,
} from '@/lib/server/execution-engine/types'
import { executeExecutionChatTurn } from '@/lib/server/execution-engine/chat-turn'

const TAG = 'execution-engine'
const TASK_KNOWLEDGE_QUERY_MAX_CHARS = 1000
const TASK_KNOWLEDGE_FALLBACK_LIMIT = 4
const TASK_KNOWLEDGE_QUERY_HINT_RE = /\b(source|sources|knowledge|manual|quickstart|failure|catalog|recipe|policy|operator|docs?|swarmclaw|workflow|skill|project|runbook)\b/i
const TASK_KNOWLEDGE_TOPIC_RE = /^\s*(?:retrieval|knowledge|source)\s+topics?\s*:\s*(.+)$/i

function normalizeDynamicImport<T extends object>(module: T): T {
  return 'default' in module && module.default
    ? module.default as T
    : module
}

interface TaskAttemptState {
  runningByTaskId: Map<string, ExecutionHandle<ExecuteChatTurnResult>>
}

const taskAttemptState = hmrSingleton<TaskAttemptState>(
  '__swarmclaw_execution_engine_task_attempt__',
  () => ({
    runningByTaskId: new Map<string, ExecutionHandle<ExecuteChatTurnResult>>(),
  }),
)

function messagePreview(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().slice(0, 140)
}

function looksIncomplete(text: string): boolean {
  if (!text) return false
  const trimmed = text.trim()
  if (trimmed.endsWith('...') || trimmed.endsWith('…')) return true
  if (/(?:^|\n)#{1,3}\s+(?:Step|Phase|Next)\s+\d/i.test(trimmed.slice(-200))) return true
  const lastChunk = trimmed.slice(-300).toLowerCase()
  return /\b(?:next i(?:'ll| will)|now i(?:'ll| will)|let me (?:now|next)|moving on to|proceeding to)\b/.test(lastChunk)
}

function formatUpstreamResultsContext(task: BoardTask): string | null {
  if (!Array.isArray(task.upstreamResults) || task.upstreamResults.length === 0) return null
  const upstreamBlock = task.upstreamResults
    .map((ur) => `### ${ur.taskTitle}\n${ur.resultPreview || '(no result)'}`)
    .join('\n\n')
  return upstreamBlock ? `## Context from upstream tasks\n\n${upstreamBlock}` : null
}

export function buildTaskKnowledgeQuery(task: BoardTask): string {
  const title = typeof task.title === 'string' ? task.title.trim() : ''
  const description = typeof task.description === 'string' ? task.description.trim() : ''
  const descriptionLines = description
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  const sourceFocusedDescription = descriptionLines
    .filter((line) => TASK_KNOWLEDGE_QUERY_HINT_RE.test(line))
    .join('\n')
  const candidate = [title, sourceFocusedDescription || description]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n\n')
    .trim()
  if (candidate.length <= TASK_KNOWLEDGE_QUERY_MAX_CHARS) return candidate
  const firstSlice = Math.ceil(TASK_KNOWLEDGE_QUERY_MAX_CHARS * 0.7)
  const lastSlice = TASK_KNOWLEDGE_QUERY_MAX_CHARS - firstSlice - 6
  return `${candidate.slice(0, firstSlice)}\n...\n${candidate.slice(-lastSlice)}`.trim()
}

function normalizeFallbackKnowledgeQuery(value: string): string {
  const normalized = value
    .replace(/[_:/.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized.length <= TASK_KNOWLEDGE_QUERY_MAX_CHARS) return normalized
  return normalized.slice(0, TASK_KNOWLEDGE_QUERY_MAX_CHARS).trim()
}

function appendFallbackQuery(out: string[], seen: Set<string>, value: string): void {
  const normalized = normalizeFallbackKnowledgeQuery(value)
  if (normalized.length <= 12) return
  const key = normalized.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  out.push(normalized)
}

function buildTaskKnowledgeFallbackQueries(task: BoardTask, primaryQuery: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const description = typeof task.description === 'string' ? task.description.trim() : ''
  const descriptionLines = description
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of descriptionLines) {
    const topicMatch = line.match(TASK_KNOWLEDGE_TOPIC_RE)
    if (!topicMatch) continue
    for (const part of topicMatch[1].split(/[;,]/)) {
      appendFallbackQuery(out, seen, part)
    }
    appendFallbackQuery(out, seen, topicMatch[1])
  }

  const sourceFocusedDescription = descriptionLines
    .filter((line) => TASK_KNOWLEDGE_QUERY_HINT_RE.test(line))
    .join('\n')
  if (sourceFocusedDescription) appendFallbackQuery(out, seen, sourceFocusedDescription)
  appendFallbackQuery(out, seen, primaryQuery)
  return out
}

export function formatTaskSourceGroundingSection(trace?: KnowledgeRetrievalTrace | null): string | null {
  if (!trace || !Array.isArray(trace.hits) || trace.hits.length === 0) return null
  const groundingLines = trace.hits.slice(0, 4).map((hit) =>
    `- [${hit.chunkIndex + 1}/${hit.chunkCount}] ${hit.sourceTitle}: ${hit.snippet}`,
  )
  return `## Source Grounding\nSource-backed Knowledge retrieved for this task:\n${groundingLines.join('\n')}`
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function metadataStringArray(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function metadataKnowledgeKind(metadata: Record<string, unknown>): KnowledgeSourceKind {
  const value = metadataString(metadata, 'sourceKind')
  return value === 'file' || value === 'url' ? value : 'manual'
}

function knowledgeMemoryVisibleToAgent(entry: MemoryEntry, viewerAgentId?: string | null): boolean {
  const metadata = metadataRecord(entry.metadata)
  const scope = metadataString(metadata, 'scope')
  if (scope !== 'agent') return true
  const agentId = typeof viewerAgentId === 'string' ? viewerAgentId.trim() : ''
  if (!agentId) return false
  return metadataStringArray(metadata, 'agentIds').includes(agentId)
    || (Array.isArray(entry.sharedWith) && entry.sharedWith.includes(agentId))
}

function knowledgeMemoryToCitation(entry: MemoryEntry): KnowledgeCitation | null {
  const metadata = metadataRecord(entry.metadata)
  const sourceId = metadataString(metadata, 'sourceId') || entry.id
  const sourceTitle = metadataString(metadata, 'sourceTitle') || entry.title || 'Knowledge Source'
  const content = typeof entry.content === 'string' ? entry.content : ''
  if (!content.trim()) return null
  return {
    sourceId,
    sourceTitle,
    sourceKind: metadataKnowledgeKind(metadata),
    sourceUrl: metadataString(metadata, 'sourceUrl'),
    sourceLabel: metadataString(metadata, 'sourceLabel'),
    chunkId: entry.id,
    chunkIndex: metadataNumber(metadata, 'chunkIndex') ?? 0,
    chunkCount: metadataNumber(metadata, 'chunkCount') ?? 1,
    charStart: metadataNumber(metadata, 'charStart') ?? 0,
    charEnd: metadataNumber(metadata, 'charEnd') ?? content.length,
    sectionLabel: metadataString(metadata, 'sectionLabel'),
    snippet: content.replace(/\s+/g, ' ').trim().slice(0, 280),
    whyMatched: 'Retrieved from task-specific Knowledge memory fallback',
    score: 1,
  }
}

async function buildFallbackTaskKnowledgeRetrievalTrace(
  queries: string[],
  viewerAgentId?: string | null,
): Promise<KnowledgeRetrievalTrace | null> {
  const memoryApi = normalizeDynamicImport(await import('@/lib/server/memory/memory-db'))
  const memoryDb = memoryApi.getMemoryDb()
  const hits: KnowledgeCitation[] = []
  const seenChunkIds = new Set<string>()
  for (const query of queries) {
    const queryHits = memoryDb
      .search(query, undefined, { category: 'knowledge', rerankMode: 'lexical' })
      .filter((entry) => knowledgeMemoryVisibleToAgent(entry, viewerAgentId))
      .map((entry) => knowledgeMemoryToCitation(entry))
      .filter((hit): hit is KnowledgeCitation => hit !== null)
    for (const hit of queryHits) {
      if (seenChunkIds.has(hit.chunkId)) continue
      seenChunkIds.add(hit.chunkId)
      hits.push(hit)
      if (hits.length >= TASK_KNOWLEDGE_FALLBACK_LIMIT) break
    }
    if (hits.length >= TASK_KNOWLEDGE_FALLBACK_LIMIT) break
  }
  if (hits.length === 0) return null
  return {
    query: queries[0] || '',
    scope: 'source_knowledge',
    hits,
    retrievedAt: Date.now(),
    selectorStatus: 'not_run',
  }
}

export async function buildTaskKnowledgeRetrievalTrace(task: BoardTask): Promise<KnowledgeRetrievalTrace | null> {
  const query = buildTaskKnowledgeQuery(task)
  if (query.length <= 12) return null
  try {
    const knowledgeApi = normalizeDynamicImport(await import('@/lib/server/knowledge-sources'))
    const trace = await knowledgeApi.buildKnowledgeRetrievalTrace({
      query,
      viewerAgentId: task.agentId || null,
      limit: 4,
    })
    if (trace?.hits?.length) return trace
    return await buildFallbackTaskKnowledgeRetrievalTrace(
      buildTaskKnowledgeFallbackQueries(task, query),
      task.agentId || null,
    )
  } catch (err: unknown) {
    log.warn(TAG, `[task_attempt] Knowledge retrieval skipped for task ${task.id}:`, errorMessage(err))
    return null
  }
}

async function applyTaskKnowledgeGroundingToResult(
  result: ExecuteChatTurnResult,
  responseText: string,
  taskKnowledgeTrace: KnowledgeRetrievalTrace | null,
): Promise<ExecuteChatTurnResult> {
  const existingTrace = result.retrievalTrace || null
  const existingCitations = Array.isArray(result.citations) ? result.citations : []
  const selectedTrace = existingTrace?.hits?.length ? existingTrace : taskKnowledgeTrace
  if (!selectedTrace?.hits?.length) return result
  if (existingCitations.length > 0 && existingTrace?.hits?.length) {
    return {
      ...result,
      citations: existingCitations,
      retrievalTrace: existingTrace,
    }
  }
  try {
    const knowledgeApi = normalizeDynamicImport(await import('@/lib/server/knowledge-sources'))
    const grounding = knowledgeApi.selectKnowledgeCitations({
      responseText,
      retrievalTrace: selectedTrace,
    })
    return {
      ...result,
      citations: grounding.citations,
      retrievalTrace: grounding.retrievalTrace,
    }
  } catch (err: unknown) {
    log.warn(TAG, `[task_attempt] Knowledge citation selection skipped:`, errorMessage(err))
    return {
      ...result,
      retrievalTrace: selectedTrace,
    }
  }
}

export function buildTaskAttemptPrompt(
  task: BoardTask,
  options: { knowledgeTrace?: KnowledgeRetrievalTrace | null } = {},
): string {
  const basePrompt = task.description || task.title
  const upstreamContext = formatUpstreamResultsContext(task)
  const sourceGrounding = formatTaskSourceGroundingSection(options.knowledgeTrace || null)
  return [
    basePrompt,
    upstreamContext ? `\n${upstreamContext}` : '',
    sourceGrounding ? `\n${sourceGrounding}` : '',
    '',
    'Completion requirements:',
    '- Execute the task before replying; do not reply with only a plan.',
    '- Include concrete evidence in your final summary: changed file paths, commands run, and verification results.',
    '- If blocked, state the blocker explicitly and what input or permission is missing.',
  ].join('\n')
}

function chainCallerSignal(callerSignal: AbortSignal | undefined, controller: AbortController): void {
  if (!callerSignal) return
  if (callerSignal.aborted) {
    controller.abort()
    return
  }
  const onAbort = () => controller.abort()
  callerSignal.addEventListener('abort', onAbort, { once: true })
}

function notifyExecutionState(sessionId: string): void {
  notify('runs')
  notify('sessions')
  notify(`session:${sessionId}`)
}

function emitStatus(run: SessionRunRecord, status: SessionRunStatus, extra?: Record<string, unknown>): void {
  const { citations, retrievalTrace, ...eventExtra } = extra || {}
  appendPersistedRunEvent({
    runId: run.id,
    sessionId: run.sessionId,
    kind: run.kind,
    ownerType: run.ownerType,
    ownerId: run.ownerId,
    parentExecutionId: run.parentExecutionId,
    phase: 'status',
    status,
    summary: run.resultPreview || run.error || undefined,
    citations: citations as import('@/types').KnowledgeCitation[] | undefined,
    retrievalTrace: (retrievalTrace as import('@/types').KnowledgeRetrievalTrace | undefined) || undefined,
    event: {
      t: 'md',
      text: JSON.stringify({
        run: {
          id: run.id,
          sessionId: run.sessionId,
          kind: run.kind,
          ownerType: run.ownerType,
          ownerId: run.ownerId,
          status,
          source: run.source,
          internal: run.internal,
          ...eventExtra,
        },
      }),
    },
  })
  notifyExecutionState(run.sessionId)
}

async function executeTaskAttemptTurn(
  task: BoardTask,
  agent: Agent,
  sessionId: string,
  signal: AbortSignal,
): Promise<ExecuteChatTurnResult> {
  if (agent.autoRecovery) {
    const cwd = task.projectId
      ? `${WORKSPACE_DIR}/projects/${task.projectId}`
      : WORKSPACE_DIR
    captureGuardianCheckpoint(cwd, `task:${task.id}`)
  }

  const settings = loadSettings()
  const taskKnowledgeTrace = await buildTaskKnowledgeRetrievalTrace(task)
  const prompt = buildTaskAttemptPrompt(task, { knowledgeTrace: taskKnowledgeTrace })

  let latestRun = await executeExecutionChatTurn({
    sessionId,
    message: prompt,
    internal: false,
    source: 'task',
    runId: task.id,
    signal,
  })
  let text = typeof latestRun.text === 'string' ? latestRun.text.trim() : ''
  let previousSummary: string | null = null
  let totalInputTokens = latestRun.inputTokens || 0
  let totalOutputTokens = latestRun.outputTokens || 0
  let totalEstimatedCost = Number(latestRun.estimatedCost || 0)

  if (latestRun.error) {
    return applyTaskKnowledgeGroundingToResult({
      ...latestRun,
      text,
    }, text, taskKnowledgeTrace)
  }

  const maxSupervisorFollowups = 2
  for (let followupIndex = 0; followupIndex < maxSupervisorFollowups; followupIndex += 1) {
    if (signal.aborted) break

    const sessions = loadSessions()
    const session = sessions[sessionId] as Session | undefined
    const assessment = assessAutonomyRun({
      runId: `${task.id}:attempt-${(task.attempts || 0) + 1}:step-${followupIndex + 1}`,
      sessionId,
      taskId: task.id,
      agentId: agent.id,
      source: 'task',
      status: latestRun.error ? 'failed' : 'completed',
      resultText: text,
      error: latestRun.error,
      toolEvents: latestRun.toolEvents,
      mainLoopState: {
        followupChainCount: followupIndex + 1,
        summary: previousSummary,
        missionCostUsd: totalEstimatedCost,
      },
      session: session || null,
      settings,
    })
    if (assessment.shouldBlock) break
    if (assessment.autoActions?.length) {
      const result = await executeSupervisorAutoActions({
        actions: assessment.autoActions,
        sessionId,
        agentId: agent.id,
      })
      if (result.blocked) break
    }
    const followupMessage = assessment.interventionPrompt
      || (text && looksIncomplete(text)
        ? 'Continue and complete the remaining steps. Provide a final summary when done.'
        : null)
    if (!followupMessage) break

    if (agent.monthlyBudget || agent.dailyBudget || agent.hourlyBudget) {
      try {
        const followupBudget = checkAgentBudgetLimits(agent)
        if (!followupBudget.ok) {
          log.warn(TAG, `[task_attempt] Budget exceeded for "${agent.name}" during follow-up, stopping.`)
          break
        }
      } catch {
        // Best-effort safety check only.
      }
    }

    previousSummary = text || previousSummary
    const followUp = await executeExecutionChatTurn({
      sessionId,
      message: followupMessage,
      internal: false,
      source: 'task',
      signal,
    })
    totalInputTokens += followUp.inputTokens || 0
    totalOutputTokens += followUp.outputTokens || 0
    totalEstimatedCost += Number(followUp.estimatedCost || 0)
    text = typeof followUp.text === 'string' ? followUp.text.trim() : ''
    latestRun = {
      ...followUp,
      text,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedCost: totalEstimatedCost,
    }
    if (latestRun.error) break
  }

  return applyTaskKnowledgeGroundingToResult({
    ...latestRun,
    text,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    estimatedCost: totalEstimatedCost,
  }, text, taskKnowledgeTrace)
}

export function enqueueTaskAttemptExecution(
  input: EnqueueTaskAttemptExecutionRequest,
): ExecutionHandle<ExecuteChatTurnResult> {
  const existing = taskAttemptState.runningByTaskId.get(input.task.id)
  if (existing) return { ...existing, deduped: true }

  const executionId = input.executionId || `${input.task.id}:attempt-${(input.task.attempts || 0) + 1}`
  const controller = new AbortController()
  chainCallerSignal(input.callerSignal, controller)

  const run: SessionRunRecord = {
    id: executionId,
    sessionId: input.sessionId,
    kind: 'task_attempt',
    ownerType: 'task',
    ownerId: input.task.id,
    parentExecutionId: null,
    recoveryPolicy: 'restart_recoverable',
    source: 'task',
    internal: false,
    mode: 'task_attempt',
    status: 'queued',
    messagePreview: messagePreview(input.task.description || input.task.title),
    queuedAt: Date.now(),
  }

  persistRun(run)
  emitStatus(run, 'queued')

  const promise = (async () => {
    run.status = 'running'
    run.startedAt = Date.now()
    persistRun(run)
    emitStatus(run, 'running')

    try {
      const result = await executeTaskAttemptTurn(input.task, input.agent, input.sessionId, controller.signal)
      run.status = controller.signal.aborted
        ? 'cancelled'
        : (result.error ? 'failed' : 'completed')
      run.endedAt = Date.now()
      run.error = controller.signal.aborted ? (run.error || 'Cancelled') : result.error
      run.resultPreview = result.text?.slice(0, 280)
      run.retrievalSummary = buildRetrievalSummary(result.citations)
      if (typeof result.inputTokens === 'number') run.totalInputTokens = result.inputTokens
      if (typeof result.outputTokens === 'number') run.totalOutputTokens = result.outputTokens
      if (typeof result.estimatedCost === 'number') run.estimatedCost = result.estimatedCost
      persistRun(run)
      emitStatus(run, run.status, {
        hasText: !!result.text,
        error: run.error || null,
        citations: result.citations,
        retrievalTrace: result.retrievalTrace,
      })
      return result
    } catch (err: unknown) {
      run.status = controller.signal.aborted ? 'cancelled' : 'failed'
      run.endedAt = Date.now()
      run.error = errorMessage(err)
      persistRun(run)
      emitStatus(run, run.status, { error: run.error })
      throw err
    } finally {
      const latest = taskAttemptState.runningByTaskId.get(input.task.id)
      if (latest?.executionId === executionId) {
        taskAttemptState.runningByTaskId.delete(input.task.id)
      }
    }
  })()

  const handle: ExecutionHandle<ExecuteChatTurnResult> = {
    executionId,
    promise,
    abort: () => controller.abort(),
  }
  taskAttemptState.runningByTaskId.set(input.task.id, handle)
  return handle
}
