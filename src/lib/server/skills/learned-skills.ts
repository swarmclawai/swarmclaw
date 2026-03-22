import crypto from 'node:crypto'

import { HumanMessage } from '@langchain/core/messages'

import { genId } from '@/lib/id'
import type {
  LearnedSkill,
  LearnedSkillLifecycle,
  LearnedSkillRiskLevel,
  MessageToolEvent,
  RunReflection,
  Session,
  Skill,
} from '@/types'
import { errorMessage } from '@/lib/shared-utils'
import { buildLLM } from '@/lib/server/build-llm'
import {
  loadLearnedSkill,
  loadLearnedSkills,
  loadRunReflection,
  loadSkills,
  upsertRunReflection,
  upsertLearnedSkill,
} from '@/lib/server/skills/skill-repository'
import { loadSession } from '@/lib/server/sessions/session-repository'
import { getMessages, getMessageCount } from '@/lib/server/messages/message-repository'
import { buildSessionTranscript } from './skill-suggestions'
import { normalizeSkillPayload } from './skills-normalize'
import { onNextIdleWindow } from '@/lib/server/runtime/idle-window'

const SUCCESS_EVIDENCE_THRESHOLD = 2
const FAILURE_EVIDENCE_THRESHOLD = 2
const DEMOTION_FAILURE_THRESHOLD = 2
const REVIEW_READY_SUCCESS_THRESHOLD = 2
const MAX_USER_MESSAGE_CHARS = 800

const SUCCESS_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'before', 'by', 'for', 'from', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our',
  'please', 'that', 'the', 'this', 'to', 'up', 'use', 'we', 'with', 'you', 'your',
])

const HIGH_RISK_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bformat\s+disk\b/i,
]

type ObservationKind = 'success_pattern' | 'failure_repair'

interface LearnedSkillDraft {
  workflowKey: string
  objectiveSummary: string
  name: string
  description: string
  content: string
  tags?: string[]
  rationale?: string | null
  confidence?: number | null
  riskLevel?: LearnedSkillRiskLevel | null
}

export interface ObserveLearnedSkillRunInput {
  runId: string
  sessionId: string
  agentId?: string | null
  source: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  resultText?: string | null
  error?: string | null
  toolEvents?: MessageToolEvent[]
  reflection?: RunReflection | null
}

export interface ObserveLearnedSkillRunOptions {
  generateText?: (prompt: string) => Promise<string>
}

interface Observation {
  kind: ObservationKind
  workflowKey: string
  objectiveSummary: string
  sourceHash: string
  sourceSnippet: string
  failureFamily?: string | null
}

interface ValidationResult {
  status: LearnedSkill['validationStatus']
  summary: string
}

function trimText(value: string, max = 320): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function normalizeKey(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function hashText(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex')
}

function safeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .map((entry) => (typeof entry === 'string' ? trimText(entry, 80) : ''))
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

function maybeParseJson(text: string): Record<string, unknown> | null {
  const raw = text.trim()
  const candidates = [
    raw,
    raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''),
  ]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // ignore and continue
    }
  }
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0])
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function extractModelText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') ? part.text : '')
    .join('')
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(1, value))
}

function normalizeRiskLevel(value: unknown): LearnedSkillRiskLevel | null {
  if (value === 'low' || value === 'medium' || value === 'high') return value
  return null
}

function ensureHeading(name: string, content: string): string {
  const trimmed = content.trim()
  if (!trimmed) return `# ${name}\n\nUse this skill when the same workflow or failure family appears again.`
  if (/^#\s+/m.test(trimmed)) return trimmed
  return `# ${name}\n\n${trimmed}`
}

function collectRecentUserText(session: Session): string {
  return getMessages(session.id)
    .filter((message) => message?.role === 'user' && !message.suppressed && typeof message.text === 'string')
    .slice(-3)
    .map((message) => message.text)
    .join('\n')
    .slice(-MAX_USER_MESSAGE_CHARS)
}

function tokenizeObjective(text: string): string[] {
  return trimText(text, MAX_USER_MESSAGE_CHARS)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !SUCCESS_STOPWORDS.has(token))
}

function deriveSuccessWorkflowKey(session: Session, toolEvents: MessageToolEvent[]): string {
  const userTokens = Array.from(new Set(tokenizeObjective(collectRecentUserText(session)))).slice(0, 5)
  const toolTokens = Array.from(new Set(
    toolEvents
      .map((event) => normalizeKey(event?.name))
      .filter(Boolean),
  )).slice(0, 3)
  const parts = [...toolTokens, ...userTokens].filter(Boolean)
  return `success:${parts.join('_') || normalizeKey(session.name) || 'workflow'}`
}

function summarizeSuccessObjective(session: Session, toolEvents: MessageToolEvent[]): string {
  const userText = trimText(collectRecentUserText(session), 220)
  const toolSummary = Array.from(new Set(toolEvents.map((event) => trimText(event?.name || '', 40)).filter(Boolean))).join(', ')
  if (userText && toolSummary) return `${userText} (tools: ${toolSummary})`
  return userText || toolSummary || trimText(session.name, 220) || 'Recurring workflow'
}

function classifyFailureFamily(input: {
  error?: string | null
  resultText?: string | null
  toolEvents?: MessageToolEvent[]
}): { family: string; objectiveSummary: string } | null {
  const toolNames = Array.isArray(input.toolEvents)
    ? input.toolEvents.map((event) => String(event?.name || '')).join(' ')
    : ''
  const outputs = Array.isArray(input.toolEvents)
    ? input.toolEvents.map((event) => `${event?.input || ''} ${event?.output || ''}`).join(' ')
    : ''
  const haystack = `${input.error || ''}\n${input.resultText || ''}\n${toolNames}\n${outputs}`.toLowerCase()
  if (!haystack.trim()) return null
  const hasExternalSignal = /\b(whatsapp|slack|discord|telegram|teams|matrix|email|smtp|gmail|webhook|provider|api|gateway|connector|elevenlabs|voice|tts)\b/i.test(haystack)

  const families: Array<{ family: string; summary: string; pattern: RegExp }> = [
    { family: 'external_whatsapp_voice_delivery', summary: 'WhatsApp voice or audio delivery repair', pattern: /(whatsapp|voice note|audio).*?(elevenlabs|voice|tts)|(?:elevenlabs|voice|tts).*?(whatsapp|voice note|audio)/i },
    { family: 'external_whatsapp_delivery', summary: 'WhatsApp delivery repair', pattern: /\bwhatsapp\b/i },
    { family: 'external_webhook_delivery', summary: 'Webhook delivery repair', pattern: /\bwebhook\b/i },
    { family: 'external_slack_delivery', summary: 'Slack delivery repair', pattern: /\bslack\b/i },
    { family: 'external_discord_delivery', summary: 'Discord delivery repair', pattern: /\bdiscord\b/i },
    { family: 'external_telegram_delivery', summary: 'Telegram delivery repair', pattern: /\btelegram\b/i },
    { family: 'external_email_delivery', summary: 'Email delivery repair', pattern: /\b(email|smtp|imap|gmail)\b/i },
    { family: 'external_voice_synthesis', summary: 'Voice synthesis or TTS repair', pattern: /\b(elevenlabs|tts|text to speech|voice synthesis)\b/i },
    { family: 'external_provider_auth', summary: 'External provider authentication repair', pattern: /\b(unauthorized|forbidden|auth|authentication|api key|401|403)\b/i },
    { family: 'external_provider_transport', summary: 'External provider transport repair', pattern: /\b(timeout|timed out|econn|enotfound|dns|network error|connection reset|503|502|bad gateway)\b/i },
  ]

  const match = families.find((entry) => entry.pattern.test(haystack))
  if (!match) return null
  if (
    (match.family === 'external_provider_auth' || match.family === 'external_provider_transport')
    && !hasExternalSignal
  ) {
    return null
  }
  return { family: match.family, objectiveSummary: match.summary }
}

function buildFailureSourceHash(input: {
  session: Session
  resultText?: string | null
  error?: string | null
  toolEvents?: MessageToolEvent[]
  family: string
}): string {
  const toolSummary = Array.isArray(input.toolEvents)
    ? input.toolEvents.map((event) => `${event?.name || ''}:${event?.error ? 'err' : 'ok'}`).join(',')
    : ''
  return hashText([
    input.family,
    trimText(input.error || '', 200),
    trimText(input.resultText || '', 200),
    toolSummary,
    trimText(collectRecentUserText(input.session), 220),
  ].join('\n'))
}

function buildObservation(input: ObserveLearnedSkillRunInput, session: Session): Observation | null {
  if (input.status === 'cancelled' || input.status === 'queued' || input.status === 'running') return null
  if (getMessageCount(session.id) < 2) return null

  const toolEvents = Array.isArray(input.toolEvents) ? input.toolEvents : []
  const sourceSnippet = trimText(buildSessionTranscript(session), 700)
  if (input.status === 'failed' || input.error) {
    const failure = classifyFailureFamily({
      error: input.error,
      resultText: input.resultText,
      toolEvents,
    })
    if (!failure) return null
    return {
      kind: 'failure_repair',
      workflowKey: failure.family,
      objectiveSummary: failure.objectiveSummary,
      sourceHash: buildFailureSourceHash({
        session,
        resultText: input.resultText,
        error: input.error,
        toolEvents,
        family: failure.family,
      }),
      sourceSnippet,
      failureFamily: failure.family,
    }
  }

  if (toolEvents.length === 0) return null
  return {
    kind: 'success_pattern',
    workflowKey: deriveSuccessWorkflowKey(session, toolEvents),
    objectiveSummary: summarizeSuccessObjective(session, toolEvents),
    sourceHash: hashText(`${buildSessionTranscript(session)}\n${toolEvents.map((event) => `${event.name}:${event.error ? 'err' : 'ok'}`).join(',')}`),
    sourceSnippet,
    failureFamily: null,
  }
}

function buildDraftPrompt(params: {
  session: Session
  observation: Observation
  reflection: RunReflection | null
  existingSkillNames: string[]
}): string {
  const toolSummary = getMessages(params.session.id)
    .flatMap((message) => message?.toolEvents || [])
    .slice(-8)
    .map((event) => `- ${event.name} (${event.error ? 'error' : 'ok'})`)
    .join('\n')

  const reflectionNotes = params.reflection
    ? [
      ...(params.reflection.failureNotes || []),
      ...(params.reflection.lessonNotes || []),
      ...(params.reflection.learnedSkillNotes || []),
    ].slice(0, 8).map((note) => `- ${note}`).join('\n')
    : ''

  return [
    'Turn repeated user work into an agent-scoped learned skill.',
    'Return JSON only.',
    'The learned skill must be low-risk, reusable, and specific to the repeated workflow or failure family.',
    'Do not produce a globally shared skill. This is an agent-scoped learned skill.',
    params.observation.kind === 'failure_repair'
      ? 'This skill should repair or route around a repeated external API/integration failure.'
      : 'This skill should capture a repeated successful workflow for the user.',
    '',
    'Required JSON fields:',
    '- workflowKey: stable machine key for this workflow or failure family',
    '- objectiveSummary: one sentence',
    '- name: short reusable skill name',
    '- description: one sentence',
    '- content: markdown skill body with concrete steps',
    '- tags: 2-6 short tags',
    '- rationale: one short sentence',
    '- confidence: number from 0 to 1',
    '- riskLevel: "low", "medium", or "high"',
    '',
    'Rules:',
    '- Prefer low-risk operational workflows.',
    '- Do not include secrets, tokens, personal names, or unique IDs.',
    '- Do not assume global permissions or destructive commands.',
    '- If the workflow is too risky, set riskLevel to "high".',
    params.existingSkillNames.length > 0
      ? `Avoid duplicating these names: ${params.existingSkillNames.join(', ')}`
      : '',
    '',
    `Observation kind: ${params.observation.kind}`,
    `Workflow key: ${params.observation.workflowKey}`,
    `Objective summary: ${params.observation.objectiveSummary}`,
    params.observation.failureFamily ? `Failure family: ${params.observation.failureFamily}` : '',
    '',
    'Recent transcript:',
    params.observation.sourceSnippet,
    '',
    toolSummary ? `Recent tool summary:\n${toolSummary}\n` : '',
    reflectionNotes ? `Reflection notes:\n${reflectionNotes}\n` : '',
  ].filter(Boolean).join('\n')
}

function parseDraftResponse(raw: string): LearnedSkillDraft {
  const parsed = maybeParseJson(raw)
  if (!parsed) throw new Error('Model did not return valid JSON for the learned skill draft.')
  const normalized = normalizeSkillPayload({
    name: parsed.name,
    description: parsed.description,
    content: parsed.content,
    tags: safeStringArray(parsed.tags),
    sourceFormat: 'plain',
  })
  const workflowKey = normalizeKey(typeof parsed.workflowKey === 'string' ? parsed.workflowKey : normalized.name)
  return {
    workflowKey: workflowKey || normalizeKey(normalized.name),
    objectiveSummary: trimText(typeof parsed.objectiveSummary === 'string' ? parsed.objectiveSummary : normalized.description || 'Learned workflow', 220),
    name: normalized.name,
    description: normalized.description || '',
    content: ensureHeading(normalized.name, normalized.content || ''),
    tags: normalized.tags,
    rationale: typeof parsed.rationale === 'string' ? trimText(parsed.rationale, 220) : null,
    confidence: normalizeConfidence(parsed.confidence),
    riskLevel: normalizeRiskLevel(parsed.riskLevel),
  }
}

async function generateDraft(params: {
  session: Session
  agentId: string
  observation: Observation
  reflection: RunReflection | null
  options?: ObserveLearnedSkillRunOptions
}): Promise<LearnedSkillDraft> {
  const existingSkillNames = [
    ...Object.values(loadSkills()).map((skill: Skill) => trimText(skill.name || '', 80)),
    ...Object.values(loadLearnedSkills()).map((skill) => trimText(skill.name || '', 80)),
  ].filter(Boolean).slice(0, 60)

  const prompt = buildDraftPrompt({
    session: params.session,
    observation: params.observation,
    reflection: params.reflection,
    existingSkillNames,
  })

  const responseText = params.options?.generateText
    ? await params.options.generateText(prompt)
    : await (async () => {
      const { llm } = await buildLLM({
        sessionId: params.session.id,
        agentId: params.agentId,
      })
      const response = await llm.invoke([new HumanMessage(prompt)])
      return extractModelText(response.content)
    })()

  const draft = parseDraftResponse(responseText)
  return {
    ...draft,
    workflowKey: params.observation.workflowKey,
    objectiveSummary: draft.objectiveSummary || params.observation.objectiveSummary,
  }
}

function validateDraft(skill: LearnedSkill): ValidationResult {
  const content = String(skill.content || '').trim()
  const risk = skill.riskLevel || 'low'
  if (!content || content.length < 40) {
    return { status: 'failed', summary: 'Draft content is too small to be reusable.' }
  }
  if (risk === 'high') {
    return { status: 'failed', summary: 'Draft was marked high risk and cannot auto-activate.' }
  }
  if (HIGH_RISK_PATTERNS.some((pattern) => pattern.test(content))) {
    return { status: 'failed', summary: 'Draft includes high-risk instructions and cannot auto-activate.' }
  }
  const evidenceThreshold = skill.sourceKind === 'failure_repair'
    ? FAILURE_EVIDENCE_THRESHOLD
    : SUCCESS_EVIDENCE_THRESHOLD
  if ((skill.evidenceCount || 0) < evidenceThreshold) {
    return {
      status: 'pending',
      summary: `Waiting for ${evidenceThreshold} matching observations before activation.`,
    }
  }
  return { status: 'passed', summary: 'Policy checks passed and evidence threshold was met.' }
}

function appendReflectionLearnedSkillNotes(params: {
  reflection: RunReflection | null
  notes: string[]
  skillIds: string[]
}): void {
  if (!params.reflection || (params.notes.length === 0 && params.skillIds.length === 0)) return
  const current = loadRunReflection(params.reflection.id)
  if (!current) return
  upsertRunReflection(current.id, {
    ...current,
    learnedSkillNotes: Array.from(new Set([
      ...(current.learnedSkillNotes || []),
      ...params.notes,
    ])),
    learnedSkillIds: Array.from(new Set([
      ...(current.learnedSkillIds || []),
      ...params.skillIds,
    ])),
    updatedAt: Date.now(),
  })
}

function matchesSelectedLearnedSkill(session: Session, skill: LearnedSkill): boolean {
  const selected = typeof session.skillRuntimeState?.selectedSkillId === 'string'
    ? session.skillRuntimeState.selectedSkillId.trim()
    : ''
  if (!selected) return false
  return selected === skill.id || selected === `runtime:learned:${skill.id}`
}

function listAgentFamilySkills(params: {
  agentId: string
  workflowKey: string
}): LearnedSkill[] {
  return Object.values(loadLearnedSkills())
    .filter((skill) => skill.agentId === params.agentId && skill.workflowKey === params.workflowKey)
    .sort((a, b) => (a.updatedAt || a.createdAt) - (b.updatedAt || b.createdAt))
}

function buildBaseLearnedSkill(params: {
  agentId: string
  session: Session
  observation: Observation
  parentSkillId?: string | null
  lifecycle?: LearnedSkillLifecycle
}): LearnedSkill {
  const now = Date.now()
  return {
    id: genId(),
    parentSkillId: params.parentSkillId || null,
    agentId: params.agentId,
    userId: typeof params.session.user === 'string' ? params.session.user : null,
    sessionId: params.session.id,
    scope: 'agent',
    lifecycle: params.lifecycle || 'candidate',
    sourceKind: params.observation.kind,
    workflowKey: params.observation.workflowKey,
    failureFamily: params.observation.failureFamily || null,
    objectiveSummary: params.observation.objectiveSummary,
    validationStatus: 'pending',
    validationEvidenceCount: 0,
    evidenceCount: 1,
    activationCount: 0,
    successCount: params.observation.kind === 'success_pattern' ? 1 : 0,
    failureCount: params.observation.kind === 'failure_repair' ? 1 : 0,
    consecutiveSuccessCount: params.observation.kind === 'success_pattern' ? 1 : 0,
    consecutiveFailureCount: params.observation.kind === 'failure_repair' ? 1 : 0,
    lastSourceHash: params.observation.sourceHash,
    lastSucceededAt: params.observation.kind === 'success_pattern' ? now : null,
    lastFailedAt: params.observation.kind === 'failure_repair' ? now : null,
    sourceSessionName: params.session.name,
    sourceSnippet: params.observation.sourceSnippet,
    createdAt: now,
    updatedAt: now,
  }
}

function shouldDraftNewRevision(activeSkill: LearnedSkill | null, observation: Observation): boolean {
  if (!activeSkill) return false
  if (observation.kind !== 'success_pattern') return false
  const activeHash = typeof activeSkill.lastSourceHash === 'string' ? activeSkill.lastSourceHash.trim() : ''
  return Boolean(observation.sourceHash && activeHash && observation.sourceHash !== activeHash)
}

function formatLifecycleNote(skill: LearnedSkill, note: string): string {
  const name = skill.name || skill.workflowKey
  return `${name}: ${note}`
}

const REFINEMENT_INTERVAL = 3

function buildRefinementPrompt(skill: LearnedSkill): string {
  return [
    'You are a skill refinement engine.',
    'Given a learned skill definition that has been used successfully multiple times, produce a refined version.',
    'Return JSON only with a single field: "content" (refined markdown skill body).',
    '',
    'Rules:',
    '- Preserve the core workflow steps.',
    '- Tighten wording, remove redundancy, add clarity from repeated use.',
    '- Do not add new steps or change the risk level.',
    '- Keep the same heading structure.',
    '',
    `Skill name: ${skill.name}`,
    `Description: ${skill.description || 'N/A'}`,
    `Success count: ${skill.successCount || 0}`,
    `Refinement count: ${skill.refinementCount || 0}`,
    '',
    'Current content:',
    skill.content || '',
  ].join('\n')
}

async function refineSkillContent(skill: LearnedSkill, agentId: string): Promise<void> {
  try {
    const prompt = buildRefinementPrompt(skill)
    const { llm } = await buildLLM({ agentId })
    const response = await llm.invoke([new HumanMessage(prompt)])
    const text = extractModelText(response.content)
    const parsed = maybeParseJson(text)
    if (!parsed || typeof parsed.content !== 'string' || parsed.content.trim().length < 40) return
    const updated = { ...skill }
    updated.content = ensureHeading(updated.name || 'Skill', parsed.content)
    updated.lastRefinedAt = Date.now()
    updated.refinementCount = (updated.refinementCount || 0) + 1
    updated.updatedAt = Date.now()
    upsertLearnedSkill(updated.id, updated)
  } catch {
    // Refinement is best-effort; failures are silently ignored
  }
}

export function listLearnedSkills(filters?: {
  agentId?: string
  sessionId?: string
  lifecycle?: LearnedSkill['lifecycle']
}): LearnedSkill[] {
  return Object.values(loadLearnedSkills())
    .filter((skill) => (!filters?.agentId || skill.agentId === filters.agentId))
    .filter((skill) => (!filters?.sessionId || skill.sessionId === filters.sessionId))
    .filter((skill) => (!filters?.lifecycle || skill.lifecycle === filters.lifecycle))
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
}

export async function observeLearnedSkillRunOutcome(
  input: ObserveLearnedSkillRunInput,
  options?: ObserveLearnedSkillRunOptions,
): Promise<{ notes: string[]; skillIds: string[] }> {
  const agentId = typeof input.agentId === 'string' ? input.agentId.trim() : ''
  if (!agentId) return { notes: [], skillIds: [] }
  const session = loadSession(input.sessionId)
  if (!session) return { notes: [], skillIds: [] }

  const observation = buildObservation(input, session)
  if (!observation) return { notes: [], skillIds: [] }

  const notes: string[] = []
  const touchedSkillIds = new Set<string>()
  const familySkills = listAgentFamilySkills({ agentId, workflowKey: observation.workflowKey })
  const activeSkill = [...familySkills].reverse().find((skill) => skill.lifecycle === 'active') || null
  const demotedSkill = [...familySkills].reverse().find((skill) => skill.lifecycle === 'demoted') || null
  const pendingSkill = [...familySkills].reverse().find((skill) => skill.lifecycle === 'candidate' || skill.lifecycle === 'shadow' || skill.lifecycle === 'review_ready') || null

  if (activeSkill && matchesSelectedLearnedSkill(session, activeSkill)) {
    const next = { ...activeSkill }
    next.lastUsedAt = Date.now()
    const qualityScore = typeof input.reflection?.qualityScore === 'number' ? input.reflection.qualityScore : null
    if (observation.kind === 'success_pattern') {
      const cumulativeIncrement = qualityScore !== null && qualityScore >= 0.8 ? 2 : 1
      next.successCount = (next.successCount || 0) + cumulativeIncrement
      next.consecutiveSuccessCount = (next.consecutiveSuccessCount || 0) + 1
      next.consecutiveFailureCount = 0
      next.lastSucceededAt = Date.now()
      next.lastSourceHash = observation.sourceHash
      if ((next.successCount || 0) >= REVIEW_READY_SUCCESS_THRESHOLD && next.lifecycle === 'active') {
        next.reviewReadyAt = next.reviewReadyAt || Date.now()
      }
      notes.push(formatLifecycleNote(next, 'recorded another successful learned-skill run'))
      if ((next.successCount || 0) % REFINEMENT_INTERVAL === 0 && next.lifecycle === 'active' && next.content) {
        const skillSnapshot = { ...next }
        const capturedAgentId = agentId
        onNextIdleWindow(() => refineSkillContent(skillSnapshot, capturedAgentId))
      }
    } else {
      const cumulativeIncrement = qualityScore !== null && qualityScore <= 0.3 ? 2 : 1
      next.failureCount = (next.failureCount || 0) + cumulativeIncrement
      next.consecutiveFailureCount = (next.consecutiveFailureCount || 0) + 1
      next.consecutiveSuccessCount = 0
      next.lastFailedAt = Date.now()
      if ((next.consecutiveFailureCount || 0) >= DEMOTION_FAILURE_THRESHOLD) {
        next.lifecycle = 'demoted'
        next.demotedAt = Date.now()
        next.demotionReason = trimText(input.error || input.resultText || 'Repeated learned skill failures', 220)
        notes.push(formatLifecycleNote(next, 'auto-demoted after repeated failures'))
      } else {
        notes.push(formatLifecycleNote(next, 'recorded a failed learned-skill run'))
      }
    }
    next.updatedAt = Date.now()
    upsertLearnedSkill(next.id, next)
    touchedSkillIds.add(next.id)
  }

  let target = pendingSkill
  const shouldCreateRevision = shouldDraftNewRevision(activeSkill, observation)
  if (!target || shouldCreateRevision || (demotedSkill && !pendingSkill)) {
    target = buildBaseLearnedSkill({
      agentId,
      session,
      observation,
      parentSkillId: shouldCreateRevision
        ? activeSkill?.id || null
        : demotedSkill?.id || null,
      lifecycle: shouldCreateRevision || demotedSkill ? 'shadow' : 'candidate',
    })
    notes.push(formatLifecycleNote(target, shouldCreateRevision
      ? 'started a shadow revision from a newer successful workflow'
      : demotedSkill
        ? 'started a shadow retry after a demotion'
        : 'captured a new learned-skill candidate'))
  } else {
    target = { ...target }
    target.evidenceCount = (target.evidenceCount || 0) + 1
    if (observation.kind === 'success_pattern') {
      target.successCount = (target.successCount || 0) + 1
      target.consecutiveSuccessCount = (target.consecutiveSuccessCount || 0) + 1
      target.consecutiveFailureCount = 0
      target.lastSucceededAt = Date.now()
    } else {
      target.failureCount = (target.failureCount || 0) + 1
      target.consecutiveFailureCount = (target.consecutiveFailureCount || 0) + 1
      target.consecutiveSuccessCount = 0
      target.lastFailedAt = Date.now()
    }
    target.lastSourceHash = observation.sourceHash
    target.sourceSnippet = observation.sourceSnippet
    target.sourceSessionName = session.name
    target.updatedAt = Date.now()
  }

  if (!target.name || !target.content) {
    try {
      const draft = await generateDraft({
        session,
        agentId,
        observation,
        reflection: input.reflection || null,
        options,
      })
      target.workflowKey = draft.workflowKey || target.workflowKey
      target.objectiveSummary = draft.objectiveSummary || target.objectiveSummary
      target.name = draft.name
      target.description = draft.description
      target.content = draft.content
      target.tags = draft.tags
      target.rationale = draft.rationale
      target.confidence = draft.confidence
      target.riskLevel = draft.riskLevel || 'low'
    } catch (err: unknown) {
      target.validationStatus = 'failed'
      target.validationSummary = `Draft generation failed: ${errorMessage(err)}`
      target.updatedAt = Date.now()
      upsertLearnedSkill(target.id, target)
      touchedSkillIds.add(target.id)
      notes.push(formatLifecycleNote(target, 'draft generation failed'))
      appendReflectionLearnedSkillNotes({
        reflection: input.reflection || null,
        notes,
        skillIds: [...touchedSkillIds],
      })
      return { notes, skillIds: [...touchedSkillIds] }
    }
  }

  const validation = validateDraft(target)
  target.validationStatus = validation.status
  target.validationSummary = validation.summary
  target.validationEvidenceCount = target.evidenceCount || 0
  target.updatedAt = Date.now()

  if (validation.status === 'passed') {
    const parent = target.parentSkillId
      ? loadLearnedSkill(target.parentSkillId)
      : null
    if (parent && parent.lifecycle === 'active') {
      target.lifecycle = 'review_ready'
      target.reviewReadyAt = target.reviewReadyAt || Date.now()
      notes.push(formatLifecycleNote(target, 'shadow revision passed validation and is review-ready'))
    } else {
      target.lifecycle = 'active'
      target.activationCount = (target.activationCount || 0) + 1
      target.reviewReadyAt = null
      notes.push(formatLifecycleNote(target, 'activated for the originating agent'))
    }
    if (parent && parent.lifecycle === 'demoted') {
      const parentNext = { ...parent }
      parentNext.retryUnlockedAt = Date.now()
      parentNext.retryUnlockedByReflectionId = input.reflection?.id || null
      parentNext.retryUnlockedBySkillId = target.id
      parentNext.updatedAt = Date.now()
      upsertLearnedSkill(parentNext.id, parentNext)
      touchedSkillIds.add(parentNext.id)
      notes.push(formatLifecycleNote(parentNext, 'retry unlocked by a new shadow revision'))
    }
  } else if (validation.status === 'pending') {
    notes.push(formatLifecycleNote(target, validation.summary))
  } else {
    notes.push(formatLifecycleNote(target, validation.summary))
  }

  upsertLearnedSkill(target.id, target)
  touchedSkillIds.add(target.id)
  appendReflectionLearnedSkillNotes({
    reflection: input.reflection || null,
    notes,
    skillIds: [...touchedSkillIds],
  })
  return { notes, skillIds: [...touchedSkillIds] }
}
