import { HumanMessage } from '@langchain/core/messages'

import { genId } from '@/lib/id'
import { buildLLM } from '@/lib/server/build-llm'
import { log } from '@/lib/server/logger'
import { cleanText, cleanMultiline, normalizeList } from '@/lib/server/text-normalization'
import type {
  EvidenceRef,
  MessageToolEvent,
  SessionWorkingState,
  WorkingArtifact,
  WorkingArtifactPatch,
  WorkingBlockerPatch,
  WorkingDecisionPatch,
  WorkingFactPatch,
  WorkingHypothesisPatch,
  WorkingPlanStepPatch,
  WorkingQuestionPatch,
  WorkingStatePatch,
} from '@/types'

import {
  EXTRACTION_TIMEOUT_MS,
  WorkingStatePatchSchema,
  normalizeEvidenceIds,
  now,
} from '@/lib/server/working-state/normalization'
import type {
  SynchronizeWorkingStateForTurnInput,
  WorkingStateDeterministicUpdateInput,
  WorkingStateExtractionInput,
} from '@/lib/server/working-state/normalization'

const TAG = 'working-state'

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

export function parseStructuredObject(raw: string): Record<string, unknown> | null {
  const text = cleanMultiline(raw, 20_000)
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return null
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function extractFirstJsonObject(text: string): string | null {
  const source = String(text || '').trim()
  if (!source) return null
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (start === -1) {
      if (char === '{') {
        start = index
        depth = 1
      }
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }
  return null
}

export function parseWorkingStatePatchResponse(text: string): WorkingStatePatch | null {
  const jsonText = extractFirstJsonObject(text)
  if (!jsonText) return null
  let raw: unknown = null
  try {
    raw = JSON.parse(jsonText)
  } catch {
    return null
  }
  const parsed = WorkingStatePatchSchema.safeParse(raw)
  if (!parsed.success) return null
  const data = parsed.data
  return {
    objective: cleanMultiline(data.objective, 900) || null,
    summary: cleanMultiline(data.summary, 600) || null,
    constraints: normalizeList(data.constraints, 12, 240),
    successCriteria: normalizeList(data.successCriteria, 12, 240),
    status: data.status || null,
    nextAction: cleanText(data.nextAction, 240) || null,
    planSteps: Array.isArray(data.planSteps)
      ? data.planSteps
        .map((step) => {
          const text = cleanText(step.text, 240)
          if (!text) return null
          return {
            id: cleanText(step.id, 120) || null,
            text,
            status: step.status || undefined,
          } satisfies WorkingPlanStepPatch
        })
        .filter(Boolean) as WorkingPlanStepPatch[]
      : undefined,
    factsUpsert: Array.isArray(data.factsUpsert)
      ? data.factsUpsert
        .map((fact) => {
          const statement = cleanText(fact.statement, 280)
          if (!statement) return null
          return {
            id: cleanText(fact.id, 120) || null,
            statement,
            source: fact.source || undefined,
            status: fact.status || undefined,
            evidenceIds: normalizeEvidenceIds(fact.evidenceIds),
          } satisfies WorkingFactPatch
        })
        .filter(Boolean) as WorkingFactPatch[]
      : undefined,
    artifactsUpsert: Array.isArray(data.artifactsUpsert)
      ? data.artifactsUpsert
        .map((artifact) => {
          const label = cleanText(artifact.label, 240)
          if (!label) return null
          return {
            id: cleanText(artifact.id, 120) || null,
            label,
            kind: artifact.kind || undefined,
            path: cleanText(artifact.path, 320) || null,
            url: cleanText(artifact.url, 320) || null,
            sourceTool: cleanText(artifact.sourceTool, 120) || null,
            status: artifact.status || undefined,
            evidenceIds: normalizeEvidenceIds(artifact.evidenceIds),
          } satisfies WorkingArtifactPatch
        })
        .filter(Boolean) as WorkingArtifactPatch[]
      : undefined,
    decisionsAppend: Array.isArray(data.decisionsAppend)
      ? data.decisionsAppend
        .map((decision) => {
          const summary = cleanText(decision.summary, 280)
          if (!summary) return null
          return {
            id: cleanText(decision.id, 120) || null,
            summary,
            rationale: cleanText(decision.rationale, 320) || null,
            status: decision.status || undefined,
            evidenceIds: normalizeEvidenceIds(decision.evidenceIds),
          } satisfies WorkingDecisionPatch
        })
        .filter(Boolean) as WorkingDecisionPatch[]
      : undefined,
    blockersUpsert: Array.isArray(data.blockersUpsert)
      ? data.blockersUpsert
        .map((blocker) => {
          const summary = cleanText(blocker.summary, 280)
          if (!summary) return null
          return {
            id: cleanText(blocker.id, 120) || null,
            summary,
            kind: blocker.kind || undefined,
            nextAction: cleanText(blocker.nextAction, 240) || null,
            status: blocker.status || undefined,
            evidenceIds: normalizeEvidenceIds(blocker.evidenceIds),
          } satisfies WorkingBlockerPatch
        })
        .filter(Boolean) as WorkingBlockerPatch[]
      : undefined,
    questionsUpsert: Array.isArray(data.questionsUpsert)
      ? data.questionsUpsert
        .map((question) => {
          const value = cleanText(question.question, 280)
          if (!value) return null
          return {
            id: cleanText(question.id, 120) || null,
            question: value,
            status: question.status || undefined,
            evidenceIds: normalizeEvidenceIds(question.evidenceIds),
          } satisfies WorkingQuestionPatch
        })
        .filter(Boolean) as WorkingQuestionPatch[]
      : undefined,
    hypothesesUpsert: Array.isArray(data.hypothesesUpsert)
      ? data.hypothesesUpsert
        .map((hypothesis) => {
          const statement = cleanText(hypothesis.statement, 280)
          if (!statement) return null
          return {
            id: cleanText(hypothesis.id, 120) || null,
            statement,
            confidence: hypothesis.confidence || undefined,
            status: hypothesis.status || undefined,
            evidenceIds: normalizeEvidenceIds(hypothesis.evidenceIds),
          } satisfies WorkingHypothesisPatch
        })
        .filter(Boolean) as WorkingHypothesisPatch[]
      : undefined,
    supersedeIds: normalizeList(data.supersedeIds, 24, 120),
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers for extraction prompt
// ---------------------------------------------------------------------------

export function renderStateForExtraction(state: SessionWorkingState | null | undefined): string {
  if (!state) return '(none)'
  const activePlan = state.planSteps.filter((item) => item.status === 'active').map((item) => item.text).slice(0, 8)
  const facts = state.confirmedFacts.filter((item) => item.status === 'active').map((item) => item.statement).slice(0, 8)
  const blockers = state.blockers.filter((item) => item.status === 'active').map((item) => item.summary).slice(0, 6)
  const questions = state.openQuestions.filter((item) => item.status === 'active').map((item) => item.question).slice(0, 6)
  const hypotheses = state.hypotheses.filter((item) => item.status === 'active').map((item) => item.statement).slice(0, 6)
  const artifacts = state.artifacts.filter((item) => item.status === 'active').map((item) => cleanText(item.path || item.url || item.label, 180)).slice(0, 6)
  return [
    `objective: ${JSON.stringify(state.objective || null)}`,
    `summary: ${JSON.stringify(state.summary || null)}`,
    `status: ${JSON.stringify(state.status)}`,
    `nextAction: ${JSON.stringify(state.nextAction || null)}`,
    `constraints: ${JSON.stringify(state.constraints || [])}`,
    `successCriteria: ${JSON.stringify(state.successCriteria || [])}`,
    `activePlan: ${JSON.stringify(activePlan)}`,
    `facts: ${JSON.stringify(facts)}`,
    `blockers: ${JSON.stringify(blockers)}`,
    `openQuestions: ${JSON.stringify(questions)}`,
    `hypotheses: ${JSON.stringify(hypotheses)}`,
    `artifacts: ${JSON.stringify(artifacts)}`,
  ].join('\n')
}

export function summarizeToolEvents(toolEvents: MessageToolEvent[] | undefined): string {
  if (!Array.isArray(toolEvents) || toolEvents.length === 0) return '(none)'
  return toolEvents
    .slice(-8)
    .map((event) => {
      const name = cleanText(event.name, 80) || 'unknown'
      const input = cleanText(event.input, 160)
      const output = cleanText(event.output, 200)
      const parts = [name]
      if (input) parts.push(`input=${JSON.stringify(input)}`)
      if (output) parts.push(`output=${JSON.stringify(output)}`)
      if (event.error === true) parts.push('error=true')
      if (event.toolCallId) parts.push(`toolCallId=${JSON.stringify(event.toolCallId)}`)
      return parts.join(' ')
    })
    .join('\n')
}

// ---------------------------------------------------------------------------
// Prompt building for extraction LLM call
// ---------------------------------------------------------------------------

export function buildWorkingStatePatchPrompt(input: WorkingStateExtractionInput): string {
  return [
    'You maintain a structured working-state object for an autonomous agent.',
    'Return JSON only.',
    '',
    'Update the state using only evidence from the latest turn and tool results.',
    'Rules:',
    '- Facts must be confirmed by explicit user text or tool evidence. Do not turn guesses into facts.',
    '- Put uncertain leads into hypotheses, not facts.',
    '- Use blockers for approvals, credentials, human input, external waits, and explicit execution failures.',
    '- nextAction must be one concrete immediate action, not a broad plan.',
    '- Keep entries concise and avoid duplicates with the current state.',
    '- If newer evidence invalidates an existing live item, include its id in supersedeIds.',
    '- Do not repeat the entire state. Only emit useful deltas.',
    '- If nothing material changed, return {}.',
    '',
    'Output shape:',
    JSON.stringify({
      objective: 'optional',
      summary: 'optional',
      constraints: ['optional'],
      successCriteria: ['optional'],
      status: 'idle|progress|blocked|waiting|completed',
      nextAction: 'optional',
      planSteps: [{ id: 'optional', text: 'step', status: 'active|resolved|superseded' }],
      factsUpsert: [{ id: 'optional', statement: 'confirmed fact', source: 'user|tool|assistant|system', status: 'active|resolved|superseded', evidenceIds: ['optional'] }],
      artifactsUpsert: [{ id: 'optional', label: 'artifact', kind: 'file|url|approval|message|other', path: 'optional', url: 'optional', sourceTool: 'optional', status: 'active|resolved|superseded', evidenceIds: ['optional'] }],
      decisionsAppend: [{ summary: 'decision', rationale: 'optional', status: 'active|resolved|superseded', evidenceIds: ['optional'] }],
      blockersUpsert: [{ summary: 'blocker', kind: 'approval|credential|human_input|external_dependency|error|other', nextAction: 'optional', status: 'active|resolved|superseded', evidenceIds: ['optional'] }],
      questionsUpsert: [{ question: 'open question', status: 'active|resolved|superseded', evidenceIds: ['optional'] }],
      hypothesesUpsert: [{ statement: 'possible lead', confidence: 'low|medium|high', status: 'active|resolved|superseded', evidenceIds: ['optional'] }],
      supersedeIds: ['optional item id'],
    }),
    '',
    `source: ${JSON.stringify(cleanText(input.source, 80) || 'chat')}`,
    `current_state:\n${renderStateForExtraction(input.currentState)}`,
    `user_message: ${JSON.stringify(cleanMultiline(input.message, 1200) || null)}`,
    `assistant_text: ${JSON.stringify(cleanMultiline(input.assistantText, 1200) || null)}`,
    `assistant_error: ${JSON.stringify(cleanText(input.error, 320) || null)}`,
    `tool_evidence:\n${summarizeToolEvents(input.toolEvents)}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Plain-text artifact extraction helpers
// ---------------------------------------------------------------------------

export function collectJsonCandidates(value: unknown, pathLabel = '', out?: Array<{ key: string; value: string }>): Array<{ key: string; value: string }> {
  const results = out || []
  if (!value) return results
  if (typeof value === 'string') {
    const cleaned = cleanText(value, 400)
    if (cleaned) results.push({ key: pathLabel, value: cleaned })
    return results
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonCandidates(entry, pathLabel, results)
    return results
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      collectJsonCandidates(nested, key, results)
    }
  }
  return results
}

export function uniqueByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = keyFn(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^\/api\/uploads\//.test(value) || /^sandbox:\/\//i.test(value)
}

export function looksLikeFilePath(value: string): boolean {
  return /^(?:\.{1,2}\/|\/|[A-Za-z0-9_-]+\/)/.test(value)
    || /^sandbox:\//.test(value)
}

export function extractPlainTextArtifacts(text: string): Array<{ kind: WorkingArtifact['kind']; value: string }> {
  const out: Array<{ kind: WorkingArtifact['kind']; value: string }> = []
  if (!text) return out
  const urlMatches = text.match(/(?:https?:\/\/|\/api\/uploads\/|sandbox:\/\/)[^\s)\]}>,"]+/g) || []
  for (const match of urlMatches) out.push({ kind: 'url', value: match })
  const pathMatches = text.match(/(?:^|[\s("'`])((?:\.{1,2}\/|\/|sandbox:\/)[A-Za-z0-9._\-\/]+(?:\.[A-Za-z0-9]{1,8})?)/g) || []
  for (const raw of pathMatches) {
    const match = raw.trim().replace(/^[(\s"'`]+/, '')
    if (match) out.push({ kind: 'file', value: match })
  }
  return uniqueByKey(out, (item) => `${item.kind}:${item.value}`)
}

// ---------------------------------------------------------------------------
// deterministicEvidencePatch
// ---------------------------------------------------------------------------

export function deterministicEvidencePatch(input: WorkingStateDeterministicUpdateInput): WorkingStatePatch {
  const nowTs = now()
  const evidenceAppend: EvidenceRef[] = []
  const artifactsUpsert: WorkingArtifactPatch[] = []
  const blockersUpsert: WorkingBlockerPatch[] = []
  const factsUpsert: WorkingFactPatch[] = []

  if (input.runId) {
    evidenceAppend.push({
      id: genId(12),
      type: 'message',
      summary: `Run ${input.runId} completed on ${cleanText(input.source, 80) || 'chat'}.`,
      value: input.runId,
      runId: input.runId,
      sessionId: input.sessionId,
      createdAt: nowTs,
    })
  }

  if (Array.isArray(input.toolEvents)) {
    input.toolEvents.forEach((event, index) => {
      const toolName = cleanText(event.name, 80) || 'unknown'
      const output = cleanText(event.output, 240)
      const summary = event.error === true
        ? `Tool ${toolName} returned an explicit error.`
        : `Tool ${toolName} produced new execution evidence.`
      const evidenceId = `${event.toolCallId || `${toolName}-${index}`}-${genId(6)}`
      evidenceAppend.push({
        id: evidenceId,
        type: event.error === true ? 'error' : 'tool',
        summary,
        value: output || cleanText(event.input, 240) || null,
        toolName,
        toolCallId: cleanText(event.toolCallId, 120) || null,
        runId: input.runId || null,
        sessionId: input.sessionId,
        createdAt: nowTs + index,
      })

      if (event.error === true) {
        blockersUpsert.push({
          summary: output || `Tool ${toolName} failed.`,
          kind: 'error',
          nextAction: null,
          status: 'active',
          evidenceIds: [evidenceId],
        })
      }

      const structuredInput = parseStructuredObject(event.input)
      const structuredOutput = parseStructuredObject(event.output || '')
      const candidates = [
        ...collectJsonCandidates(structuredInput),
        ...collectJsonCandidates(structuredOutput),
        ...extractPlainTextArtifacts(event.output || ''),
      ].map((entry) => {
        if ('kind' in entry) return entry
        const value = entry.value
        if (looksLikeUrl(value)) return { kind: 'url' as const, value }
        if (looksLikeFilePath(value)) return { kind: 'file' as const, value }
        return null
      }).filter(Boolean) as Array<{ kind: WorkingArtifact['kind']; value: string }>

      for (const candidate of uniqueByKey(candidates, (item) => `${item.kind}:${item.value}`)) {
        artifactsUpsert.push({
          label: candidate.value,
          kind: candidate.kind,
          path: candidate.kind === 'file' ? candidate.value : null,
          url: candidate.kind === 'url' ? candidate.value : null,
          sourceTool: toolName,
          status: 'active',
          evidenceIds: [evidenceId],
        })
      }

      const approvalRecord = structuredOutput || structuredInput
      const approvalId = cleanText(
        approvalRecord?.approvalId
        || (approvalRecord?.approval && typeof approvalRecord.approval === 'object'
          ? (approvalRecord.approval as Record<string, unknown>).id
          : null),
        120,
      )
      const requiresApproval = approvalRecord?.requiresApproval === true || Boolean(approvalId)
      if (requiresApproval) {
        const approvalLabel = approvalId ? `Approval ${approvalId}` : `Approval required for ${toolName}`
        artifactsUpsert.push({
          label: approvalLabel,
          kind: 'approval',
          sourceTool: toolName,
          status: 'active',
          evidenceIds: [evidenceId],
        })
        blockersUpsert.push({
          summary: approvalId
            ? `Approval ${approvalId} is required before continuing.`
            : `Approval is required before continuing ${toolName}.`,
          kind: 'approval',
          status: 'active',
          evidenceIds: [evidenceId],
        })
        if (approvalId) {
          factsUpsert.push({
            statement: `Pending approval id: ${approvalId}`,
            source: 'tool',
            status: 'active',
            evidenceIds: [evidenceId],
          })
        }
      }

      const taskId = cleanText(
        structuredOutput?.taskId
        || structuredInput?.taskId
        || (Array.isArray(structuredOutput?.taskIds) ? structuredOutput?.taskIds[0] : null),
        120,
      )
      if (taskId) {
        factsUpsert.push({
          statement: `Task id in play: ${taskId}`,
          source: 'tool',
          status: 'active',
          evidenceIds: [evidenceId],
        })
      }
    })
  }

  if (input.error) {
    evidenceAppend.push({
      id: genId(12),
      type: 'error',
      summary: `Assistant run ended with an explicit error.`,
      value: cleanText(input.error, 240) || null,
      runId: input.runId || null,
      sessionId: input.sessionId,
      createdAt: nowTs + 100,
    })
    blockersUpsert.push({
      summary: cleanText(input.error, 280),
      kind: 'error',
      status: 'active',
    })
  }

  return {
    status: input.error
      ? 'blocked'
      : undefined,
    nextAction: undefined,
    factsUpsert: factsUpsert.length > 0 ? factsUpsert : undefined,
    artifactsUpsert: artifactsUpsert.length > 0 ? artifactsUpsert : undefined,
    blockersUpsert: blockersUpsert.length > 0 ? blockersUpsert : undefined,
    evidenceAppend: evidenceAppend.length > 0 ? evidenceAppend : undefined,
  }
}

// ---------------------------------------------------------------------------
// extractWorkingStatePatch — async LLM call
// ---------------------------------------------------------------------------

export async function extractWorkingStatePatch(
  input: WorkingStateExtractionInput,
  options?: {
    generateText?: (prompt: string) => Promise<string>
  },
): Promise<WorkingStatePatch | null> {
  const prompt = buildWorkingStatePatchPrompt(input)
  try {
    const responseText = options?.generateText
      ? await options.generateText(prompt)
      : await (async () => {
        const { llm } = await buildLLM({
          sessionId: input.sessionId,
          agentId: input.agentId || null,
        })
        const response = await Promise.race([
          llm.invoke([new HumanMessage(prompt)]),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('working-state-extraction-timeout')), EXTRACTION_TIMEOUT_MS)),
        ])
        const content = response.content
        if (typeof content === 'string') return content
        if (!Array.isArray(content)) return ''
        return content
          .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') ? part.text : '')
          .join('')
      })()
    return parseWorkingStatePatchResponse(responseText)
  } catch (error: unknown) {
    log.warn(TAG, 'Working-state extraction failed', {
      sessionId: input.sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

// ---------------------------------------------------------------------------
// shouldExtractStructuredPatch
// ---------------------------------------------------------------------------

export function shouldExtractStructuredPatch(input: SynchronizeWorkingStateForTurnInput): boolean {
  const hasToolEvents = Array.isArray(input.toolEvents) && input.toolEvents.length > 0
  const hasMessage = cleanMultiline(input.message, 400).length > 0
  const hasAssistantText = cleanMultiline(input.assistantText, 400).length > 0
  const hasError = cleanText(input.error, 120).length > 0
  if (cleanText(input.source, 80) === 'heartbeat') {
    return hasToolEvents || hasError
  }
  return hasToolEvents || hasAssistantText || hasMessage || hasError
}
