/**
 * Protocol event/transcript handling, agent turn execution, and artifact persistence.
 * Groups G7 + G8 + G9 from protocol-service.ts
 */
import { HumanMessage } from '@langchain/core/messages'
import { z } from 'zod'
import { log } from '@/lib/server/logger'
import { genId } from '@/lib/id'

const TAG = 'protocol-agent-turn'
import type {
  Agent,
  Chatroom,
  ChatroomMessage,
  ProtocolPhaseDefinition,
  ProtocolRun,
  ProtocolRunArtifact,
  ProtocolRunEvent,
} from '@/types'
import {
  appendSyntheticSessionMessage,
  buildAgentSystemPromptForChatroom,
  buildChatroomSystemPrompt,
  buildHistoryForAgent,
  ensureSyntheticSession,
  resolveAgentApiEndpoint,
  resolveApiKey,
} from '@/lib/server/chatrooms/chatroom-helpers'
import { streamAgentChat } from '@/lib/server/chat-execution/stream-agent-chat'
import { shouldSuppressHiddenControlText, stripHiddenControlTokens } from '@/lib/server/agents/assistant-control'
import { resolvePrimaryAgentRoute } from '@/lib/server/agents/agent-runtime-config'
import { getAgent, getAgents } from '@/lib/server/agents/agent-repository'
import { buildLLM } from '@/lib/server/build-llm'
import {
  loadChatroom,
  patchChatroom,
  upsertChatroom,
} from '@/lib/server/chatrooms/chatroom-repository'
import {
  loadProtocolRunEventsByRunId,
  patchProtocolRun,
  upsertProtocolRun,
  upsertProtocolRunEvent,
} from '@/lib/server/protocols/protocol-run-repository'
import { notify } from '@/lib/server/ws-hub'
import { errorMessage } from '@/lib/shared-utils'
import { AGENT_TURN_TIMEOUT_MS, cleanText, now } from '@/lib/server/protocols/protocol-types'
import type { ProtocolAgentTurnResult, ProtocolRunDeps } from '@/lib/server/protocols/protocol-types'
import { normalizeProtocolRun } from '@/lib/server/protocols/protocol-normalization'
import { persistChatroomInteractionMemory } from '@/lib/server/chatrooms/chatroom-memory-bridge'
import { selectKnowledgeCitations } from '@/lib/server/knowledge-sources'

// ---- Zod schema ----

export const ActionItemsSchema = z.object({
  tasks: z.array(z.object({
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    agentId: z.string().nullable().optional(),
  })).max(8).default([]),
})

// ---- Event/Transcript (G7) ----

export function transcriptRoomName(title: string, parent: Chatroom | null): string {
  const base = cleanText(title, 80) || 'Structured Session'
  if (!parent) return base
  return `${cleanText(parent.name, 48) || 'Chatroom'} · ${base}`
}

export function appendProtocolEvent(runId: string, event: Omit<ProtocolRunEvent, 'id' | 'runId' | 'createdAt'>, deps?: ProtocolRunDeps): ProtocolRunEvent {
  const record: ProtocolRunEvent = {
    id: genId(),
    runId,
    createdAt: now(deps),
    ...event,
  }
  upsertProtocolRunEvent(record.id, record)
  notify('protocol_runs')
  notify(`protocol_run:${runId}`)
  return record
}

export function listEvents(runId: string): ProtocolRunEvent[] {
  return loadProtocolRunEventsByRunId(runId)
}

export function appendTranscriptMessage(chatroomId: string, message: Omit<ChatroomMessage, 'id' | 'time'>, deps?: ProtocolRunDeps): ChatroomMessage | null {
  const nextMessage: ChatroomMessage = {
    ...message,
    id: genId(),
    time: now(deps),
  }
  const updated = patchChatroom(chatroomId, (current) => {
    if (!current) return null
    return {
      ...current,
      messages: Array.isArray(current.messages) ? [...current.messages, nextMessage] : [nextMessage],
      updatedAt: nextMessage.time,
    }
  })
  if (!updated) return null
  notify(`chatroom:${chatroomId}`)
  return nextMessage
}

export function chooseFacilitator(run: ProtocolRun): string | null {
  if (typeof run.facilitatorAgentId === 'string' && run.facilitatorAgentId.trim()) return run.facilitatorAgentId.trim()
  return run.participantAgentIds[0] || null
}

// ---- Agent Turn (G8) ----

export function buildPhasePrompt(run: ProtocolRun, phase: ProtocolPhaseDefinition, agentId: string): string {
  const agentLabel = agentId
  const goal = cleanText(run.config?.goal, 400) || cleanText(run.title, 220)
  const kickoff = cleanText(run.config?.kickoffMessage, 800)
  const decisionMode = cleanText(run.config?.decisionMode, 120)
  const roundLimit = typeof run.config?.roundLimit === 'number' ? run.config?.roundLimit : null
  const phaseInstructions = cleanText(phase.instructions, 600)

  if (phase.kind === 'collect_independent_inputs') {
    return [
      `Structured session: ${run.title}`,
      `Objective: ${goal}`,
      kickoff ? `Context: ${kickoff}` : '',
      `Current phase: ${phase.label}`,
      'Provide your independent contribution for this structured session.',
      'Do not assume access to the other participants\' answers yet.',
      phaseInstructions ? `Additional instructions: ${phaseInstructions}` : '',
      `Participant: ${agentLabel}`,
    ].filter(Boolean).join('\n')
  }

  if (phase.kind === 'round_robin') {
    return [
      `Structured session: ${run.title}`,
      `Objective: ${goal}`,
      kickoff ? `Context: ${kickoff}` : '',
      `Current phase: ${phase.label}`,
      'Provide your concise turn for the structured session.',
      roundLimit ? `Current round limit: ${roundLimit}` : '',
      phaseInstructions ? `Additional instructions: ${phaseInstructions}` : '',
      `Participant: ${agentLabel}`,
    ].filter(Boolean).join('\n')
  }

  if (phase.kind === 'compare') {
    return [
      `Structured session: ${run.title}`,
      `Objective: ${goal}`,
      `Current phase: ${phase.label}`,
      'Compare the participant contributions already visible in the transcript.',
      'Highlight the strongest differences, overlaps, and tradeoffs.',
      phaseInstructions ? `Additional instructions: ${phaseInstructions}` : '',
    ].filter(Boolean).join('\n')
  }

  if (phase.kind === 'decide') {
    return [
      `Structured session: ${run.title}`,
      `Objective: ${goal}`,
      `Current phase: ${phase.label}`,
      'Produce the current decision or synthesized outcome for this structured session.',
      decisionMode ? `Decision mode: ${decisionMode}` : '',
      phaseInstructions ? `Additional instructions: ${phaseInstructions}` : '',
    ].filter(Boolean).join('\n')
  }

  if (phase.kind === 'summarize') {
    return [
      `Structured session: ${run.title}`,
      `Objective: ${goal}`,
      `Current phase: ${phase.label}`,
      'Write the concluding structured summary for this run.',
      'Include the current outcome, notable contributions, and next actions when relevant.',
      phaseInstructions ? `Additional instructions: ${phaseInstructions}` : '',
    ].filter(Boolean).join('\n')
  }

  return [
    `Structured session: ${run.title}`,
    `Objective: ${goal}`,
    `Current phase: ${phase.label}`,
    phaseInstructions || 'Continue the structured session.',
  ].join('\n')
}

export async function defaultExecuteAgentTurn(params: {
  run: ProtocolRun
  phase: ProtocolPhaseDefinition
  agentId: string
  prompt: string
}): Promise<ProtocolAgentTurnResult> {
  const agent = getAgent(params.agentId) as Agent | null
  if (!agent) throw new Error(`Agent not found: ${params.agentId}`)
  let run = params.run
  if (!run.transcriptChatroomId) {
    const transcript = createTranscriptRoom({
      runId: run.id,
      title: run.title,
      participantAgentIds: run.participantAgentIds,
      parentChatroomId: run.parentChatroomId || null,
    })
    run = persistRun({
      ...run,
      transcriptChatroomId: transcript.id,
      updatedAt: Date.now(),
    })
  }
  const chatroom = loadChatroom(run.transcriptChatroomId!)
  if (!chatroom) throw new Error(`Structured session transcript room not found: ${run.transcriptChatroomId}`)
  const agents = {
    ...getAgents(chatroom.agentIds),
    [agent.id]: agent,
  } as Record<string, Agent>

  const route = resolvePrimaryAgentRoute(agent)
  const apiKey = resolveApiKey(route?.credentialId || agent.credentialId)
  const syntheticSession = ensureSyntheticSession(agent, chatroom.id)
  syntheticSession.provider = route?.provider || syntheticSession.provider
  syntheticSession.model = route?.model || syntheticSession.model
  syntheticSession.credentialId = route?.credentialId ?? syntheticSession.credentialId ?? null
  syntheticSession.fallbackCredentialIds = route?.fallbackCredentialIds || syntheticSession.fallbackCredentialIds || []
  syntheticSession.gatewayProfileId = route?.gatewayProfileId ?? syntheticSession.gatewayProfileId ?? null
  syntheticSession.apiEndpoint = route?.apiEndpoint || resolveAgentApiEndpoint(agent)
  const protocolContext = [
    '## Structured Session Context',
    `Run title: ${params.run.title}`,
    `Template: ${params.run.templateName}`,
    `Phase: ${params.phase.label} (${params.phase.kind})`,
  ].join('\n')
  const fullSystemPrompt = [
    buildAgentSystemPromptForChatroom(agent, syntheticSession.cwd),
    buildChatroomSystemPrompt(chatroom, agents, agent.id),
    protocolContext,
  ].filter(Boolean).join('\n\n')

  appendSyntheticSessionMessage(syntheticSession.id, 'user', params.prompt)

  const MAX_RETRIES = 3
  const BASE_DELAY_MS = 2_000
  let lastError: unknown = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
      log.warn(TAG, `retrying agent turn for ${params.agentId} (attempt ${attempt + 1}/${MAX_RETRIES + 1}, waiting ${delay}ms)`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
    try {
      const result = await Promise.race([
        streamAgentChat({
          session: syntheticSession,
          message: params.prompt,
          apiKey,
          systemPrompt: fullSystemPrompt,
          write: () => {},
          history: buildHistoryForAgent(chatroom, agent.id),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Agent turn timed out after ${AGENT_TURN_TIMEOUT_MS / 1000}s (agent: ${params.agentId})`)), AGENT_TURN_TIMEOUT_MS),
        ),
      ])
      const rawText = result.finalResponse || result.fullText || ''
      const text = stripHiddenControlTokens(rawText)
      const grounding = selectKnowledgeCitations({
        responseText: text,
        retrievalTrace: result.knowledgeRetrievalTrace || null,
      })
      if (text.trim() && !shouldSuppressHiddenControlText(rawText)) {
        appendSyntheticSessionMessage(syntheticSession.id, 'assistant', text)
        // Persist interaction to agent memory (fire-and-forget)
        persistChatroomInteractionMemory({
          agentId: params.agentId,
          agent,
          chatroomId: chatroom.id,
          chatroomName: chatroom.name,
          senderName: 'Protocol',
          inboundText: params.prompt,
          responseText: text,
        }).catch(() => {})
      }
      return {
        text: cleanText(text, 6_000),
        toolEvents: result.toolEvents || [],
        citations: grounding.citations,
        retrievalTrace: grounding.retrievalTrace,
      }
    } catch (err: unknown) {
      lastError = err
      const msg = errorMessage(err)
      const isRetryable = /\b(401|429|5\d{2}|timeout|ECONNR|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed)\b/i.test(msg)
      if (!isRetryable || attempt >= MAX_RETRIES) throw err
      log.warn(TAG, `transient LLM error for agent ${params.agentId}: ${msg}`)
    }
  }
  throw lastError
}

export function extractFirstJsonObject(text: string): string | null {
  const source = String(text || '')
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

export async function defaultExtractActionItems(params: {
  run: ProtocolRun
  phase: ProtocolPhaseDefinition
  artifact: ProtocolRunArtifact
}): Promise<Array<{ title: string; description?: string | null; agentId?: string | null }>> {
  const facilitatorId = chooseFacilitator(params.run)
  if (!facilitatorId) return []
  try {
    const { llm } = await buildLLM({
      sessionId: params.run.sessionId || null,
      agentId: facilitatorId,
    })
    const prompt = [
      'Turn the structured session output into backlog tasks.',
      'Return JSON only.',
      '',
      'Rules:',
      '- Emit at most 8 tasks.',
      '- Each task title should be short and actionable.',
      '- description is optional.',
      '- agentId is optional and should only be filled when the session output clearly points to one participant.',
      '',
      'Output shape:',
      '{"tasks":[{"title":"required","description":"optional","agentId":"optional"}]}',
      '',
      `run_title: ${JSON.stringify(cleanText(params.run.title, 200) || '(none)')}`,
      `phase: ${JSON.stringify(params.phase.label)}`,
      `summary: ${JSON.stringify(cleanText(params.artifact.content, 8_000) || '(none)')}`,
    ].join('\n')
    const response = await llm.invoke([new HumanMessage(prompt)])
    const jsonText = extractFirstJsonObject(String(response.content || ''))
    if (!jsonText) return []
    const parsed = ActionItemsSchema.safeParse(JSON.parse(jsonText))
    if (!parsed.success) return []
    return parsed.data.tasks.map((task) => ({
      title: cleanText(task.title, 140),
      description: cleanText(task.description, 600) || null,
      agentId: cleanText(task.agentId, 64) || null,
    })).filter((task) => task.title)
  } catch (err: unknown) {
    appendProtocolEvent(params.run.id, {
      type: 'warning',
      phaseId: params.phase.id,
      summary: `Action item extraction failed: ${cleanText(errorMessage(err), 200) || 'unknown error'}`,
    })
    return []
  }
}

// ---- Artifact/Persistence (G9) ----

export function createTranscriptRoom(input: {
  runId: string
  title: string
  participantAgentIds: string[]
  parentChatroomId?: string | null
}, deps?: ProtocolRunDeps): Chatroom {
  const parentChatroom = input.parentChatroomId ? loadChatroom(input.parentChatroomId) : null
  const room: Chatroom = {
    id: genId(),
    name: transcriptRoomName(input.title, parentChatroom),
    description: 'Temporary structured session transcript',
    agentIds: [...input.participantAgentIds],
    messages: [],
    chatMode: 'sequential',
    autoAddress: false,
    temporary: true,
    hidden: true,
    archivedAt: null,
    protocolRunId: input.runId,
    parentChatroomId: input.parentChatroomId || null,
    createdAt: now(deps),
    updatedAt: now(deps),
  }
  upsertChatroom(room.id, room)
  return room
}

export function createArtifact(run: ProtocolRun, phase: ProtocolPhaseDefinition, kind: ProtocolRunArtifact['kind'], title: string, content: string, deps?: ProtocolRunDeps): ProtocolRunArtifact {
  return {
    id: genId(),
    kind,
    title,
    content,
    phaseId: phase.id,
    createdAt: now(deps),
  }
}

export function persistRun(run: ProtocolRun): ProtocolRun {
  const normalized = normalizeProtocolRun(run)
  upsertProtocolRun(normalized.id, normalized)
  notify('protocol_runs')
  notify(`protocol_run:${normalized.id}`)
  return normalized
}

export function updateRun(runId: string, updater: (current: ProtocolRun) => ProtocolRun | null): ProtocolRun | null {
  const updated = patchProtocolRun(runId, (current) => {
    if (!current) return null
    const normalized = normalizeProtocolRun(current)
    return updater(normalized)
  })
  if (updated) {
    notify('protocol_runs')
    notify(`protocol_run:${runId}`)
  }
  return updated
}
