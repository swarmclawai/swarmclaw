import { loadSettings, loadSkills, loadCredentials, decryptKey } from './storage'
import { buildCurrentDateTimePromptContext } from './prompt-runtime-context'
import type { Chatroom, Agent, Session, Message } from '@/types'

/** Resolve API key from an agent's credentialId */
export function resolveApiKey(credentialId: string | null | undefined): string | null {
  if (!credentialId) return null
  const creds = loadCredentials()
  const cred = creds[credentialId]
  if (!cred?.encryptedKey) return null
  try { return decryptKey(cred.encryptedKey) } catch { return null }
}

/** Parse @mentions from message text, returns matching agentIds */
export function parseMentions(text: string, agents: Record<string, Agent>, memberIds: string[]): string[] {
  if (/@all\b/i.test(text)) return [...memberIds]
  const mentionPattern = /@(\S+)/g
  const mentioned: string[] = []
  let match: RegExpExecArray | null
  while ((match = mentionPattern.exec(text)) !== null) {
    const name = match[1].toLowerCase()
    for (const id of memberIds) {
      const agent = agents[id]
      if (agent && agent.name.toLowerCase().replace(/\s+/g, '') === name) {
        if (!mentioned.includes(id)) mentioned.push(id)
      }
    }
  }
  return mentioned
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

  const recentMessages = chatroom.messages.slice(-30).map((m) => {
    return `[${m.senderName}]: ${m.text}`
  }).join('\n')

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
  const history = chatroom.messages.slice(-50).map((m) => {
    let msgText = `[${m.senderName}]: ${m.text}`
    // Include attachment info in history
    if (m.attachedFiles?.length) {
      const names = m.attachedFiles.map((f) => f.split('/').pop()).join(', ')
      msgText += `\n[Attached: ${names}]`
    }
    return {
      role: m.senderId === agentId ? 'assistant' as const : 'user' as const,
      text: msgText,
      time: m.time,
      ...(m.imagePath ? { imagePath: m.imagePath } : {}),
      ...(m.attachedFiles ? { attachedFiles: m.attachedFiles } : {}),
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
