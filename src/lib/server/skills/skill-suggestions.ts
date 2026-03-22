import crypto from 'node:crypto'
import { HumanMessage } from '@langchain/core/messages'

import { genId } from '@/lib/id'
import type { Agent, Session, Skill, SkillSuggestion } from '@/types'
import { errorMessage } from '@/lib/shared-utils'
import {
  loadAgent,
} from '@/lib/server/agents/agent-repository'
import {
  loadSession,
} from '@/lib/server/sessions/session-repository'
import { getMessages, getRecentMessages } from '@/lib/server/messages/message-repository'
import {
  loadSkill,
  loadSkillSuggestion,
  loadSkillSuggestions,
  loadSkills,
  saveSkill,
  upsertSkillSuggestion,
} from '@/lib/server/skills/skill-repository'
import { buildLLM, type GenerationModelPreference } from '@/lib/server/build-llm'
import { notify } from '@/lib/server/ws-hub'
import { resolveAgentRouteCandidates } from '@/lib/server/agents/agent-runtime-config'
import { getGateway } from '@/lib/server/openclaw/gateway'
import { normalizeSkillPayload } from './skills-normalize'
import { clearDiscoveredSkillsCache } from './skill-discovery'

const DEFAULT_TRANSCRIPT_MESSAGES = 10
const DEFAULT_SNIPPET_CHARS = 600
const MAX_EXISTING_SKILL_NAMES = 40

function trimText(value: string, max = 400): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function getModelText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== 'object') return ''
        if ('text' in part && typeof part.text === 'string') return part.text
        return ''
      })
      .join('')
  }
  return ''
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
      // ignore and try the next shape
    }
  }

  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0])
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    return null
  }
  return null
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(1, value))
}

function safeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

function ensureHeading(name: string, content: string): string {
  const trimmed = content.trim()
  if (!trimmed) return `# ${name}\n\nUse this skill when it clearly applies.`
  if (/^#\s+/m.test(trimmed)) return trimmed
  return `# ${name}\n\n${trimmed}`
}

export function buildSessionTranscript(session: Session, maxMessages = DEFAULT_TRANSCRIPT_MESSAGES): string {
  const messages = getRecentMessages(session.id, maxMessages)
  const lines: string[] = []
  for (const message of messages) {
    if (!message || message.suppressed) continue
    const text = trimText(message.text || '', 700)
    const toolSummary = Array.isArray(message.toolEvents) && message.toolEvents.length > 0
      ? `\nTools: ${message.toolEvents.slice(0, 4).map((event) => {
        const status = event.error ? 'error' : 'ok'
        return `${event.name}(${status})`
      }).join(', ')}`
      : ''
    if (!text && !toolSummary) continue
    lines.push(`${message.role.toUpperCase()}: ${text}${toolSummary}`)
  }
  return lines.join('\n\n')
}

function getSessionMessageCount(session: Session): number {
  return getMessages(session.id)
    .filter((message) => message && !message.suppressed && (message.text || message.toolEvents?.length)).length
}

function buildSuggestionPrompt(params: {
  session: Session
  transcript: string
  existingSkillNames: string[]
}): string {
  const { session, transcript, existingSkillNames } = params
  return [
    'You turn SwarmClaw/OpenClaw chat transcripts into reusable operator-reviewed skill drafts.',
    'Return JSON only.',
    'If the transcript does not support a reusable skill, return {"skip":true,"reason":"..."}',
    '',
    'Required JSON fields when a skill should be created:',
    '- name: short human-readable skill name',
    '- description: one sentence',
    '- content: markdown skill body with practical reusable guidance, not transcript summary',
    '- tags: 2-6 short tags',
    '- confidence: number from 0 to 1',
    '- rationale: one short sentence explaining why this is reusable',
    '- summary: one short sentence describing the source conversation',
    '',
    'Rules:',
    '- Focus on reusable behavior, checks, and workflow ordering.',
    '- Remove secrets, tokens, hostnames, personal names, and one-off specifics unless they are generic examples.',
    '- Do not write frontmatter.',
    '- Keep the skill body concise and actionable.',
    '- Draft at most one skill.',
    '- Do not reuse or closely duplicate known existing skill names.',
    '',
    `Session: ${session.name}`,
    `Provider: ${session.provider}/${session.model}`,
    existingSkillNames.length > 0
      ? `Known skill names to avoid duplicating: ${existingSkillNames.join(', ')}`
      : '',
    '',
    'Transcript:',
    transcript,
  ].join('\n')
}

export function parseSkillSuggestionResponse(raw: string): {
  skip: boolean
  reason?: string
  suggestion?: Pick<SkillSuggestion, 'name' | 'description' | 'content' | 'tags' | 'confidence' | 'rationale' | 'summary'>
} {
  const parsed = maybeParseJson(raw)
  if (!parsed) {
    throw new Error('Model did not return valid JSON for the skill suggestion draft.')
  }

  if (parsed.skip === true) {
    return {
      skip: true,
      reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : 'No reusable skill found in this conversation.',
    }
  }

  const normalized = normalizeSkillPayload({
    name: parsed.name,
    description: parsed.description,
    content: parsed.content,
    tags: safeStringArray(parsed.tags),
    sourceFormat: 'plain',
  })

  return {
    skip: false,
    suggestion: {
      name: normalized.name,
      description: normalized.description || '',
      content: ensureHeading(normalized.name, normalized.content || ''),
      tags: normalized.tags,
      confidence: normalizeConfidence(parsed.confidence),
      rationale: typeof parsed.rationale === 'string' ? trimText(parsed.rationale, 220) : null,
      summary: typeof parsed.summary === 'string' ? trimText(parsed.summary, 220) : null,
    },
  }
}

export function listSkillSuggestions(): SkillSuggestion[] {
  return Object.values(loadSkillSuggestions())
    .sort((a, b) => {
      if (a.status !== b.status) {
        if (a.status === 'draft') return -1
        if (b.status === 'draft') return 1
      }
      return (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
    })
}

function hasConnectedOpenClawGateway(profileId?: string | null): boolean {
  return getGateway(profileId || null)?.connected === true
}

function shouldExcludeOpenClawForSkillSuggestion(session: Session, agent: Agent | null | undefined): boolean {
  const openClawRouteProfiles = agent
    ? resolveAgentRouteCandidates(agent)
      .filter((route) => route.provider === 'openclaw')
      .map((route) => route.gatewayProfileId || null)
    : []
  const gatewayProfiles = new Set<string | null>()

  if (session.provider === 'openclaw') {
    if (session.gatewayProfileId) {
      gatewayProfiles.add(session.gatewayProfileId)
    } else if (openClawRouteProfiles.length > 0) {
      openClawRouteProfiles.forEach((profileId) => gatewayProfiles.add(profileId))
    } else {
      gatewayProfiles.add(null)
    }
  }

  openClawRouteProfiles.forEach((profileId) => gatewayProfiles.add(profileId))
  if (gatewayProfiles.size === 0) return false
  return !Array.from(gatewayProfiles).some((profileId) => hasConnectedOpenClawGateway(profileId))
}

export async function createSkillSuggestionFromSession(
  sessionId: string,
  options?: { generateText?: (prompt: string) => Promise<string> },
): Promise<SkillSuggestion> {
  const session = loadSession(sessionId)
  if (!session) throw new Error(`Session "${sessionId}" not found.`)
  const agent = session.agentId ? loadAgent(session.agentId) : null

  const transcript = buildSessionTranscript(session)
  const sourceMessageCount = getSessionMessageCount(session)
  if (!transcript.trim()) {
    throw new Error('This session does not contain enough transcript text to generate a skill draft.')
  }

  const suggestions = loadSkillSuggestions()
  const sourceHash = crypto.createHash('sha1').update(transcript).digest('hex')
  const sessionDraft = Object.values(suggestions).find((entry) =>
    entry.status === 'draft'
    && entry.sourceSessionId === sessionId,
  )
  if (sessionDraft?.sourceHash === sourceHash) return sessionDraft

  const existingSkillNames = Object.values(loadSkills())
    .map((skill) => trimText(skill.name || '', 80))
    .filter(Boolean)
    .slice(0, MAX_EXISTING_SKILL_NAMES)

  const prompt = buildSuggestionPrompt({ session, transcript, existingSkillNames })
  const responseText = options?.generateText
    ? await options.generateText(prompt)
    : await (async () => {
      const preferredModels: GenerationModelPreference[] = [{
        provider: session.provider,
        model: session.model,
        credentialId: session.credentialId || null,
        apiEndpoint: session.apiEndpoint || null,
        gatewayProfileId: session.gatewayProfileId || null,
        thinkingLevel: session.thinkingLevel || null,
      }]
      if (agent) {
        preferredModels.push({
          provider: agent.provider,
          model: agent.model,
          credentialId: agent.credentialId || null,
          apiEndpoint: agent.apiEndpoint || null,
          gatewayProfileId: agent.gatewayProfileId || null,
          thinkingLevel: agent.thinkingLevel || null,
        })
      }
      const excludeProviders = shouldExcludeOpenClawForSkillSuggestion(session, agent) ? ['openclaw'] : []
      const llmResult = await (async () => {
        try {
          return await buildLLM({
            preferred: preferredModels,
            sessionId,
            agentId: agent?.id || null,
            excludeProviders,
          })
        } catch (err) {
          if (excludeProviders.includes('openclaw')) {
            throw new Error('Skill drafting is unavailable because this chat uses OpenClaw and its gateway is disconnected. Connect the gateway or configure a non-OpenClaw routed model for this agent.')
          }
          throw err
        }
      })()
      const response = await llmResult.llm.invoke([new HumanMessage(prompt)])
      return getModelText(response.content)
    })()
  const parsed = parseSkillSuggestionResponse(responseText)
  if (parsed.skip || !parsed.suggestion) {
    throw new Error(parsed.reason || 'No reusable skill draft could be generated from this conversation.')
  }

  const now = Date.now()
  const suggestionId = sessionDraft?.id || genId()
  const suggestion: SkillSuggestion = {
    id: suggestionId,
    status: 'draft',
    sourceSessionId: session.id,
    sourceSessionName: session.name,
    sourceAgentId: session.agentId || null,
    sourceAgentName: agent?.name || null,
    sourceHash,
    sourceMessageCount,
    name: parsed.suggestion.name,
    description: parsed.suggestion.description,
    content: parsed.suggestion.content,
    tags: parsed.suggestion.tags,
    confidence: parsed.suggestion.confidence,
    rationale: parsed.suggestion.rationale,
    summary: parsed.suggestion.summary,
    sourceSnippet: trimText(transcript, DEFAULT_SNIPPET_CHARS),
    createdSkillId: null,
    approvedAt: null,
    rejectedAt: null,
    createdAt: sessionDraft?.createdAt || now,
    updatedAt: now,
  }

  upsertSkillSuggestion(suggestion.id, suggestion)
  notify('skill_suggestions')
  return suggestion
}

export function materializeSkillSuggestion(id: string): { suggestion: SkillSuggestion; skill: Skill } {
  const suggestion = loadSkillSuggestion(id)
  if (!suggestion) throw new Error(`Skill suggestion "${id}" not found.`)
  if (suggestion.status === 'approved' && suggestion.createdSkillId) {
    const existing = loadSkill(suggestion.createdSkillId)
    if (existing) return { suggestion, skill: existing }
  }

  const normalized = normalizeSkillPayload({
    name: suggestion.name,
    description: suggestion.description,
    content: suggestion.content,
    tags: suggestion.tags,
    sourceFormat: 'plain',
  })

  const skillId = genId()
  const now = Date.now()
  const skills = loadSkills()
  const existingSkill = Object.values(skills).find((entry) => {
    const sameId = normalized.skillKey && entry.skillKey && entry.skillKey === normalized.skillKey
    const sameName = entry.name.trim().toLowerCase() === normalized.name.trim().toLowerCase()
    return sameId || sameName
  })
  if (existingSkill) {
    const approved: SkillSuggestion = {
      ...suggestion,
      status: 'approved',
      createdSkillId: existingSkill.id,
      approvedAt: now,
      updatedAt: now,
    }
    upsertSkillSuggestion(id, approved)
    notify('skill_suggestions')
    return { suggestion: approved, skill: existingSkill }
  }

  const skill: Skill = {
    id: skillId,
    name: normalized.name,
    filename: normalized.filename || `skill-${skillId}.md`,
    content: normalized.content,
    description: normalized.description,
    tags: normalized.tags,
    sourceFormat: normalized.sourceFormat,
    skillKey: normalized.skillKey,
    toolNames: normalized.toolNames,
    capabilities: normalized.capabilities,
    always: normalized.always,
    installOptions: normalized.installOptions,
    skillRequirements: normalized.skillRequirements,
    detectedEnvVars: normalized.detectedEnvVars,
    security: normalized.security,
    invocation: normalized.invocation,
    commandDispatch: normalized.commandDispatch,
    frontmatter: normalized.frontmatter,
    createdAt: now,
    updatedAt: now,
  }

  saveSkill(skill.id, skill)
  clearDiscoveredSkillsCache()

  const approved: SkillSuggestion = {
    ...suggestion,
    status: 'approved',
    createdSkillId: skill.id,
    approvedAt: now,
    updatedAt: now,
  }
  upsertSkillSuggestion(id, approved)
  notify('skills')
  notify('skill_suggestions')
  return { suggestion: approved, skill }
}

export function rejectSkillSuggestion(id: string): SkillSuggestion {
  const suggestion = loadSkillSuggestion(id)
  if (!suggestion) throw new Error(`Skill suggestion "${id}" not found.`)
  const rejected: SkillSuggestion = {
    ...suggestion,
    status: 'rejected',
    rejectedAt: Date.now(),
    updatedAt: Date.now(),
  }
  upsertSkillSuggestion(id, rejected)
  notify('skill_suggestions')
  return rejected
}

export function summarizeSuggestionError(err: unknown): string {
  return errorMessage(err)
}
