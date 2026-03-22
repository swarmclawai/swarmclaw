import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildCurrentDateTimePromptContext } from '@/lib/server/prompt-runtime-context'
import { buildIdentityContinuityContext } from '@/lib/server/identity-continuity'
import { genId } from '@/lib/id'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { applyResolvedRoute, resolvePrimaryAgentRoute } from '@/lib/server/agents/agent-runtime-config'
import { loadCredential, decryptKey } from '@/lib/server/credentials/credential-repository'
import { resolveProviderApiEndpoint, resolveProviderCredentialId } from '@/lib/server/provider-endpoint'
import { loadSettings } from '@/lib/server/settings/settings-repository'
import { buildRuntimeSkillPromptBlocks, resolveRuntimeSkills } from '@/lib/server/skills/runtime-skill-resolver'
import { loadSkills } from '@/lib/server/skills/skill-repository'
import { loadSession, patchSession, saveSession } from '@/lib/server/sessions/session-repository'
import { appendMessage } from '@/lib/server/messages/message-repository'
import type { Chatroom, ChatroomMember, Agent, Session, Message, ChatroomMessage } from '@/types'
import { getEnabledCapabilityIds, getEnabledToolIds } from '@/lib/capability-selection'

/** Resolve API key from an agent's credentialId */
export function resolveApiKey(credentialId: string | null | undefined): string | null {
  const resolvedCredentialId = resolveProviderCredentialId({ credentialId })
  if (!resolvedCredentialId) return null
  const cred = loadCredential(resolvedCredentialId)
  if (!cred?.encryptedKey) return null
  try { return decryptKey(cred.encryptedKey) } catch { return null }
}

/** Derive chatroom members from the `members` array if present, otherwise fallback to `agentIds` with default 'member' role. */
export function getMembers(chatroom: Chatroom): ChatroomMember[] {
  if (chatroom.members?.length) return chatroom.members
  return chatroom.agentIds.map((agentId) => ({ agentId, role: 'member' as const }))
}

/** Return the role of an agent in a chatroom, defaulting to 'member'. */
export function getMemberRole(chatroom: Chatroom, agentId: string): string {
  const members = getMembers(chatroom)
  const member = members.find((m) => m.agentId === agentId)
  return member?.role || 'member'
}

/** Check if an agent is currently muted in the chatroom. */
export function isMuted(chatroom: Chatroom, agentId: string): boolean {
  const members = getMembers(chatroom)
  const member = members.find((m) => m.agentId === agentId)
  if (!member?.mutedUntil) return false
  return new Date(member.mutedUntil).getTime() > Date.now()
}

export function resolveAgentApiEndpoint(agent: Agent): string | null {
  return resolveProviderApiEndpoint({
    provider: agent.provider,
    model: agent.model,
    ollamaMode: agent.ollamaMode ?? null,
    credentialId: agent.credentialId ?? null,
    apiEndpoint: agent.apiEndpoint ?? null,
  })
}

const COMPACTION_PREFIX = '[Conversation summary]'

function normalizeMentionToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,!?;:]+$/g, '')
    .replace(/\s+/g, '')
    .trim()
}

function truncateText(text: string, max: number): string {
  const compact = String(text || '').replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 3))}...`
}

import { isImplicitlyMentioned } from '@/lib/server/chatrooms/chatroom-agent-signals'

/** Parse @mentions from message text, returns matching agentIds */
export function parseMentions(
  text: string,
  agents: Record<string, Agent>,
  memberIds: string[],
  opts?: { replyTargetAgentId?: string | null; senderId?: string | null; skipImplicit?: boolean },
): string[] {
  if (/@all\b/i.test(text)) return [...memberIds]
  const mentioned: string[] = []

  // Build lookup: normalized agent name/id -> agentId, sorted longest-first
  const nameLookup: Array<{ normalized: string; raw: string; agentId: string }> = []
  for (const id of memberIds) {
    const agent = agents[id]
    if (!agent) continue
    if (agent.name) nameLookup.push({ normalized: normalizeMentionToken(agent.name), raw: agent.name, agentId: id })
    nameLookup.push({ normalized: normalizeMentionToken(id), raw: id, agentId: id })
  }
  // Sort longest raw name first so "Hal2k (OpenAI)" is tried before "Hal2k"
  nameLookup.sort((a, b) => b.raw.length - a.raw.length)

  // Track which @ positions have been consumed by full-name matching
  const consumedAtPositions = new Set<number>()

  // Pass 1: Full name matching (longest-first)
  // For each @ in the text, try to match full agent names
  const atRegex = /(?:^|[\s(])@/g
  let atMatch: RegExpExecArray | null
  while ((atMatch = atRegex.exec(text)) !== null) {
    const atPos = text.indexOf('@', atMatch.index)
    const afterAt = text.slice(atPos + 1)
    for (const entry of nameLookup) {
      const normalizedSlice = normalizeMentionToken(afterAt.slice(0, entry.raw.length))
      if (normalizedSlice === entry.normalized) {
        // Verify the match ends at a word boundary or end-of-string
        const endPos = atPos + 1 + entry.raw.length
        if (endPos >= text.length || /[\s,;:.!?)\]]/.test(text[endPos])) {
          if (!mentioned.includes(entry.agentId)) mentioned.push(entry.agentId)
          consumedAtPositions.add(atPos)
          break
        }
      }
    }
  }

  // Pass 2: Regex fallback for unconsumed @ positions (handles IDs like @agent_analyst)
  const mentionPattern = /(?:^|[\s(])@([a-zA-Z0-9._-]+)/g
  let match: RegExpExecArray | null
  while ((match = mentionPattern.exec(text)) !== null) {
    const atPos = text.indexOf('@', match.index)
    if (consumedAtPositions.has(atPos)) continue
    const token = normalizeMentionToken(match[1] || '')
    if (!token) continue
    for (const id of memberIds) {
      const agent = agents[id]
      const normalizedName = normalizeMentionToken(agent?.name || '')
      const normalizedId = normalizeMentionToken(id)
      if (agent && (normalizedName === token || normalizedId === token)) {
        if (!mentioned.includes(id)) mentioned.push(id)
      }
    }
  }

  // Check if the only explicit matches are the sender — if so, treat as "no explicit mentions"
  const senderId = opts?.senderId
  const explicitSelfMentioned = senderId ? mentioned.includes(senderId) : false
  const explicitNonSelf = senderId ? mentioned.filter((id) => id !== senderId) : mentioned

  // 2. Reply-based implicit mention
  // Only if no non-self explicit mentions were found.
  if (explicitNonSelf.length === 0) {
    const replyTargetAgentId = opts?.replyTargetAgentId
    if (replyTargetAgentId && memberIds.includes(replyTargetAgentId)) {
      if (!mentioned.includes(replyTargetAgentId)) mentioned.push(replyTargetAgentId)
    }
  }

  // 3. Implicit mentions (OpenClaw Style - Reading the room)
  // Only if no non-self explicit mentions found AND implicit matching is enabled.
  if (explicitNonSelf.length === 0 && !opts?.skipImplicit) {
    for (const id of memberIds) {
      const agent = agents[id]
      if (agent && isImplicitlyMentioned(text, agent)) {
        if (!mentioned.includes(id)) mentioned.push(id)
      }
    }
  }

  // Preserve explicit self-mentions so agents can intentionally address themselves.
  if (!senderId || explicitSelfMentioned) return mentioned
  return mentioned.filter((mid) => mid !== senderId)
}

export function resolveReplyTargetAgentId(
  replyToId: string | undefined,
  messages: ChatroomMessage[],
  memberIds: string[],
): string | null {
  if (!replyToId) return null
  const replyMsg = messages.find((m) => m.id === replyToId)
  if (!replyMsg) return null
  if (replyMsg.role !== 'assistant') return null
  if (!memberIds.includes(replyMsg.senderId)) return null
  return replyMsg.senderId
}

/**
 * Persisted chatroom compaction so long-lived rooms stay inside context budgets.
 * Returns true when the message list was compacted.
 */
export function compactChatroomMessages(chatroom: Chatroom, keepLast = 90): boolean {
  const maxKeep = Math.max(20, keepLast)
  if (!Array.isArray(chatroom.messages) || chatroom.messages.length <= maxKeep) return false

  const dropped = chatroom.messages.length - maxKeep
  const kept = chatroom.messages.slice(-maxKeep).filter((msg, idx) => {
    if (idx !== 0) return true
    return !(msg.senderId === 'system' && typeof msg.text === 'string' && msg.text.startsWith(COMPACTION_PREFIX))
  })
  const summaryMessage = {
    id: genId(),
    senderId: 'system',
    senderName: 'System',
    role: 'assistant' as const,
    text: `${COMPACTION_PREFIX} ${dropped} earlier chat message(s) were condensed to keep the room responsive.`,
    mentions: [],
    reactions: [],
    time: Date.now(),
  }
  chatroom.messages = [summaryMessage, ...kept]
  chatroom.updatedAt = Date.now()
  return true
}

/** Build chatroom context as a system prompt addendum with agent profiles and collaboration guidelines */
export function buildChatroomSystemPrompt(chatroom: Chatroom, agents: Record<string, Agent>, agentId: string): string {
  const selfAgent = agents[agentId]
  const selfName = selfAgent?.name || agentId

  // Build team profiles with capabilities
  const teamProfiles = chatroom.agentIds
    .filter((id) => id !== agentId)
    .map((id) => {
      const a = agents[id]
      if (!a) return null
      const tools = getEnabledToolIds(a).length ? `Tools: ${getEnabledToolIds(a).join(', ')}` : 'No specialized tools'
      const desc = a.description || a.soul || 'No description'
      return `- **${a.name}**: ${desc}\n  ${tools}`
    })
    .filter(Boolean)
    .join('\n')

  const recentMessages = chatroom.messages
    .slice(-8)
    .map((m) => `[${m.senderName}]: ${truncateText(m.text, 180)}`)
    .join('\n')

  const memberCount = chatroom.agentIds.length
  const otherNames = chatroom.agentIds
    .filter((id) => id !== agentId)
    .map((id) => agents[id]?.name)
    .filter(Boolean)

  return [
    `## Chatroom Context`,
    `You are **${selfName}** in a group chatroom called "${chatroom.name}" with ${memberCount} participants (you, ${otherNames.join(', ') || 'others'}, and the user).`,
    selfAgent?.description ? `Your role: ${selfAgent.description}` : '',
    getEnabledToolIds(selfAgent).length ? `Your available tools: ${getEnabledToolIds(selfAgent).join(', ')}` : '',
    '',
    '## Team Members',
    teamProfiles || '(no other agents)',
    '',
    '## How to Behave in This Chatroom',
    '- **You are in a group chat.** Talk like you are in a real-time conversation with teammates — be direct, casual, and concise.',
    '- **Be yourself.** Respond with personality. Don\'t give generic "let me know if you need anything" responses. Actually engage with what was said.',
    '- **Answer the question or react to the message.** If someone says "how are you doing?" just answer naturally. If someone asks a question you can help with, help directly.',
    '- **Do not meta-narrate user intent.** Avoid phrases like "it seems like you\'re trying to..." — respond directly to what they said.',
    '- **Handle greetings like a human.** For "hello", "how are you", or light check-ins, give a normal conversational reply instead of tool/process commentary.',
    '- **Keep responses short** unless depth is needed. A few sentences is usually enough. This is a chat, not an essay.',
    '- **@mention teammates** only when you genuinely need their specific expertise. Don\'t tag people just to be polite.',
    '- **Use Reactions**: To acknowledge a message, agree with a plan, or signal progress without sending a full text reply, use this format at the end of your message: [REACTION]{"emoji": "👍", "to": "message_id"}.',
    '- **Implicit Mentions**: If someone uses your name, creature, or vibe in a message but doesn\'t @tag you, they are still "reading the room" and you may respond if it\'s relevant to you.',
    '- **Don\'t narrate your capabilities** unless asked. Just demonstrate them by doing things.',
    '- **Read the room.** Look at recent messages to understand context. Don\'t repeat what others already said.',
    '- **Direct responses first.** When the user asks you a question, answer it yourself. Don\'t delegate to or coordinate with other agents unless the user explicitly requests collaboration.',
    '- **Don\'t volunteer other agents.** Saying "let me check with @Bob" when the user asked YOU is unhelpful. Answer directly.',
    '',
    '## Recent Messages',
    recentMessages || '(no messages yet)',
  ].filter((line) => line !== undefined).join('\n')
}

/** Build a synthetic session object for an agent in a chatroom */
export function resolveChatroomWorkspaceDir(chatroomId: string): string {
  return path.join(WORKSPACE_DIR, 'chatrooms', chatroomId)
}

export function resolveSyntheticSessionId(chatroomId: string, agentId: string): string {
  return `chatroom-${chatroomId}-${agentId}`
}

function buildEmptyDelegateResumeIds(): NonNullable<Session['delegateResumeIds']> {
  return {
    claudeCode: null,
    codex: null,
    opencode: null,
    gemini: null,
  }
}

export function buildSyntheticSession(agent: Agent, chatroomId: string): Session {
  const roomWorkspace = resolveChatroomWorkspaceDir(chatroomId)
  fs.mkdirSync(roomWorkspace, { recursive: true })
  const now = Date.now()
  return applyResolvedRoute({
    id: resolveSyntheticSessionId(chatroomId, agent.id),
    name: `Chatroom session for ${agent.name}`,
    cwd: roomWorkspace,
    user: 'chatroom',
    provider: agent.provider,
    model: agent.model,
    ollamaMode: agent.ollamaMode ?? null,
    credentialId: agent.credentialId ?? null,
    fallbackCredentialIds: agent.fallbackCredentialIds,
    apiEndpoint: resolveAgentApiEndpoint(agent),
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    delegateResumeIds: buildEmptyDelegateResumeIds(),
    messages: [],
    createdAt: now,
    lastActiveAt: now,
    sessionType: 'human',
    tools: getEnabledToolIds(agent),
    extensions: agent.extensions || [],
    agentId: agent.id,
  }, resolvePrimaryAgentRoute(agent))
}

export function ensureSyntheticSession(agent: Agent, chatroomId: string): Session {
  const roomWorkspace = resolveChatroomWorkspaceDir(chatroomId)
  fs.mkdirSync(roomWorkspace, { recursive: true })
  const sessionId = resolveSyntheticSessionId(chatroomId, agent.id)
  const now = Date.now()
  const existing = loadSession(sessionId)
  const session: Session = existing
    ? applyResolvedRoute({
        ...existing,
        id: sessionId,
        name: `Chatroom session for ${agent.name}`,
        cwd: roomWorkspace,
        user: 'chatroom',
        provider: agent.provider,
        model: agent.model,
        credentialId: agent.credentialId ?? null,
        fallbackCredentialIds: Array.isArray(agent.fallbackCredentialIds) ? [...agent.fallbackCredentialIds] : [],
        apiEndpoint: resolveAgentApiEndpoint(agent),
        sessionType: existing.sessionType || 'human',
        agentId: agent.id,
        tools: getEnabledToolIds(agent),
        extensions: agent.extensions || [],
        createdAt: existing.createdAt || now,
        lastActiveAt: now,
      }, resolvePrimaryAgentRoute(agent))
    : applyResolvedRoute({
        ...buildSyntheticSession(agent, chatroomId),
        fallbackCredentialIds: Array.isArray(agent.fallbackCredentialIds) ? [...agent.fallbackCredentialIds] : [],
        lastActiveAt: now,
        tools: getEnabledToolIds(agent),
        extensions: agent.extensions || [],
      }, resolvePrimaryAgentRoute(agent))

  if (!Array.isArray(session.messages)) session.messages = []
  if (!session.delegateResumeIds || typeof session.delegateResumeIds !== 'object') {
    session.delegateResumeIds = buildEmptyDelegateResumeIds()
  }
  if (session.codexThreadId === undefined) session.codexThreadId = null
  if (session.opencodeSessionId === undefined) session.opencodeSessionId = null
  saveSession(sessionId, session)
  return session
}

export function appendSyntheticSessionMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  text: string,
): void {
  const trimmed = String(text || '').trim()
  if (!trimmed) return
  const timestamp = Date.now()
  appendMessage(sessionId, {
    role,
    text: trimmed,
    time: timestamp,
  })
  patchSession(sessionId, (current) => {
    if (!current) return null
    return { ...current, lastActiveAt: timestamp }
  })
}

/** Build agent's system prompt including skills and identity context */
export function buildAgentSystemPromptForChatroom(agent: Agent, cwd?: string | null): string {
  const settings = loadSettings()
  const parts: string[] = []

  // 1. Identity & Persona (Grounded OpenClaw Style)
  const identityLines = [`## My Identity`]
  identityLines.push(`Name: ${agent.name}`)
  if (agent.emoji) identityLines.push(`Emoji: ${agent.emoji}`)
  if (agent.creature) identityLines.push(`Creature: ${agent.creature}`)
  if (agent.vibe) identityLines.push(`Vibe: ${agent.vibe}`)
  if (agent.theme) identityLines.push(`Theme: ${agent.theme}`)
  if (agent.description) identityLines.push(`Description: ${agent.description}`)
  identityLines.push('I should always embody this identity in the group chat. I am a persistent companion with my own soul and presence.')
  parts.push(identityLines.join('\n'))
  const continuityBlock = buildIdentityContinuityContext(null, agent)
  if (continuityBlock) parts.push(continuityBlock)

  // 2. Runtime & Capabilities (OpenClaw Style)
  const runtimeLines = [
    '## Runtime',
    `os=${process.platform} | host=${os.hostname()} | agent=${agent.id} | provider=${agent.provider} | model=${agent.model}`,
    `capabilities=tools,multi_agent_chatroom,collaborative_reasoning`,
  ]
  parts.push(runtimeLines.join('\n'))

  // 3. User & DateTime Context
  if (typeof settings.userPrompt === 'string' && settings.userPrompt.trim()) parts.push(`## User Instructions\n${settings.userPrompt}`)
  parts.push(buildCurrentDateTimePromptContext())

  // 4. Soul & Core Instructions
  if (agent.soul) parts.push(`## Soul\n${agent.soul}`)
  if (agent.systemPrompt) parts.push(`## System Prompt\n${agent.systemPrompt}`)

  // 5. Skills (SwarmClaw Core)
  try {
    const runtimeSkills = resolveRuntimeSkills({
      cwd,
      enabledExtensions: getEnabledCapabilityIds(agent),
      agentId: agent.id,
      agentSkillIds: agent.skillIds || [],
      storedSkills: loadSkills(),
    })
    parts.push(...buildRuntimeSkillPromptBlocks(runtimeSkills))
  } catch { /* non-critical */ }

  // 6. Thinking & Output Format (OpenClaw Style)
  const thinkingHint = [
    '## Output Format',
    'If your model supports internal reasoning/thinking, put all internal analysis inside <think>...</think> tags.',
    'Your final response to the chatroom should be clear and concise.',
    'When you have nothing to say, respond with ONLY: NO_MESSAGE',
  ]
  parts.push(thinkingHint.join('\n'))

  return parts.join('\n\n')
}

/** Convert chatroom messages to Message history format for LLM */
export function buildHistoryForAgent(chatroom: Chatroom, agentId: string, imagePath?: string, attachedFiles?: string[]): Message[] {
  const recentMessages = chatroom.messages.slice(-24)
  const includeAttachmentsFrom = Math.max(0, recentMessages.length - 6)
  const history = recentMessages.map((m, idx) => {
    let msgText = `[${m.senderName}] (id: ${m.id}): ${m.text}`
    if (m.reactions?.length) {
      const reactionSummary = m.reactions.map(r => `${r.emoji} by ${r.reactorId}`).join(', ')
      msgText += `\n[Reactions: ${reactionSummary}]`
    }
    const includeAttachments = idx >= includeAttachmentsFrom
    if (includeAttachments && m.attachedFiles?.length) {
      const names = m.attachedFiles.map((f) => f.split('/').pop()).join(', ')
      msgText += `\n[Attached: ${names}]`
    }
    return {
      role: m.senderId === agentId ? 'assistant' as const : 'user' as const,
      text: msgText,
      time: m.time,
      ...(includeAttachments && m.imagePath ? { imagePath: m.imagePath } : {}),
      ...(includeAttachments && m.attachedFiles ? { attachedFiles: m.attachedFiles } : {}),
    }
  })
  // Pass through imagePath/attachedFiles from the current message to the last history entry
  if (history.length > 0 && (imagePath || attachedFiles)) {
    const last = history[history.length - 1]
    if (imagePath && !last.imagePath) last.imagePath = imagePath
    if (attachedFiles && !last.attachedFiles) last.attachedFiles = attachedFiles
  }
  return history
}
