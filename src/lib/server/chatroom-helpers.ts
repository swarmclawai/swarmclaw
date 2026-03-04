import { loadSettings, loadSkills, loadCredentials, decryptKey } from './storage'
import { buildCurrentDateTimePromptContext } from './prompt-runtime-context'
import { genId } from '@/lib/id'
import type { Chatroom, ChatroomMember, Agent, Session, Message } from '@/types'

/** Resolve API key from an agent's credentialId */
export function resolveApiKey(credentialId: string | null | undefined): string | null {
  if (!credentialId) return null
  const creds = loadCredentials()
  const cred = creds[credentialId]
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

/** Parse @mentions from message text, returns matching agentIds */
export function parseMentions(text: string, agents: Record<string, Agent>, memberIds: string[]): string[] {
  if (/@all\b/i.test(text)) return [...memberIds]
  const mentionPattern = /(?:^|[\s(])@([a-zA-Z0-9._-]+)/g
  const mentioned: string[] = []
  let match: RegExpExecArray | null
  while ((match = mentionPattern.exec(text)) !== null) {
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
  return mentioned
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
      const tools = a.tools?.length ? `Tools: ${a.tools.join(', ')}` : 'No specialized tools'
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
    selfAgent?.tools?.length ? `Your available tools: ${selfAgent.tools.join(', ')}` : '',
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
    '- **Don\'t narrate your capabilities** unless asked. Just demonstrate them by doing things.',
    '- **Read the room.** Look at recent messages to understand context. Don\'t repeat what others already said.',
    '',
    '## Recent Messages',
    recentMessages || '(no messages yet)',
  ].filter((line) => line !== undefined).join('\n')
}

/** Build a synthetic session object for an agent in a chatroom */
export function buildSyntheticSession(agent: Agent, chatroomId: string): Session {
  return {
    id: `chatroom-${chatroomId}-${agent.id}`,
    name: `Chatroom session for ${agent.name}`,
    cwd: process.cwd(),
    user: 'chatroom',
    provider: agent.provider,
    model: agent.model,
    credentialId: agent.credentialId ?? null,
    fallbackCredentialIds: agent.fallbackCredentialIds,
    apiEndpoint: agent.apiEndpoint ?? null,
    claudeSessionId: null,
    messages: [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    tools: agent.tools || [],
    agentId: agent.id,
  }
}

/** Build agent's system prompt including skills */
export function buildAgentSystemPromptForChatroom(agent: Agent): string {
  const settings = loadSettings()
  const parts: string[] = []
  if (settings.userPrompt) parts.push(settings.userPrompt)
  parts.push(buildCurrentDateTimePromptContext())
  if (agent.soul) parts.push(agent.soul)
  if (agent.systemPrompt) parts.push(agent.systemPrompt)
  if (agent.skillIds?.length) {
    const allSkills = loadSkills()
    for (const skillId of agent.skillIds) {
      const skill = allSkills[skillId]
      if (skill?.content) parts.push(`## Skill: ${skill.name}\n${skill.content}`)
    }
  }
  return parts.join('\n\n')
}

/** Convert chatroom messages to Message history format for LLM */
export function buildHistoryForAgent(chatroom: Chatroom, agentId: string, imagePath?: string, attachedFiles?: string[]): Message[] {
  const recentMessages = chatroom.messages.slice(-24)
  const includeAttachmentsFrom = Math.max(0, recentMessages.length - 6)
  const history = recentMessages.map((m, idx) => {
    let msgText = `[${m.senderName}]: ${m.text}`
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
