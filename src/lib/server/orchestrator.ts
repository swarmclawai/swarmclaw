import crypto from 'crypto'
import {
  loadSessions, saveSessions, loadAgents,
  loadCredentials, decryptKey, loadSettings, loadSkills,
} from './storage'
import { getMemoryDb } from './memory-db'
import { getProvider } from '../providers'
import type { Agent } from '@/types'

const MAX_TURNS = 10

/**
 * Creates the orchestrator session and returns its ID immediately.
 * Call executeOrchestrator() separately to run the loop in the background.
 */
export function createOrchestratorSession(
  orchestrator: Agent,
  task: string,
  parentSessionId?: string,
  cwd?: string,
): string {
  const sessions = loadSessions()
  const sessionId = crypto.randomBytes(4).toString('hex')
  sessions[sessionId] = {
    id: sessionId,
    name: `[Orch] ${orchestrator.name}: ${task.slice(0, 40)}`,
    cwd: cwd || process.cwd(),
    user: 'system',
    provider: orchestrator.provider,
    model: orchestrator.model,
    credentialId: orchestrator.credentialId || null,
    apiEndpoint: orchestrator.apiEndpoint || null,
    claudeSessionId: null,
    messages: [] as any[],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    sessionType: 'orchestrated' as const,
    agentId: orchestrator.id,
    parentSessionId: parentSessionId || null,
  }
  saveSessions(sessions)
  return sessionId
}

export async function runOrchestrator(
  orchestrator: Agent,
  task: string,
  parentSessionId?: string,
): Promise<string> {
  const sessionId = createOrchestratorSession(orchestrator, task, parentSessionId)
  return executeOrchestrator(orchestrator, task, sessionId)
}

export async function executeOrchestrator(
  orchestrator: Agent,
  task: string,
  sessionId: string,
): Promise<string> {
  // API-based providers use LangGraph with proper tool calling
  const isApiProvider = orchestrator.provider === 'anthropic' || orchestrator.provider === 'openai' || orchestrator.provider === 'ollama'
  if (isApiProvider) {
    console.log(`[orchestrator] Using LangGraph engine for ${orchestrator.name} (${orchestrator.provider})`)
    const { executeLangGraphOrchestrator } = await import('./orchestrator-lg')
    return executeLangGraphOrchestrator(orchestrator, task, sessionId)
  }

  // claude-cli fallback (no structured tool calling)
  console.warn(`[orchestrator] Using legacy regex-based engine for ${orchestrator.name} (claude-cli)`)
  return executeOrchestratorLegacy(orchestrator, task, sessionId)
}

async function executeOrchestratorLegacy(
  orchestrator: Agent,
  task: string,
  sessionId: string,
): Promise<string> {
  const allAgents = loadAgents()
  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session) throw new Error('Orchestrator session not found')

  // Build available agents list
  const agentIds = orchestrator.subAgentIds || []
  const agents = agentIds.map((id) => allAgents[id]).filter(Boolean)
  const agentList = agents.map((a) => {
    const tools = a.tools?.length ? ` [tools: ${a.tools.join(', ')}]` : ''
    const skills = a.skills?.length ? ` [skills: ${a.skills.join(', ')}]` : ''
    return `- ${a.name}: ${a.description}${tools}${skills}`
  }).join('\n')

  // Load relevant memories
  const db = getMemoryDb()
  const memories = db.getByAgent(orchestrator.id)
  const memoryContext = memories.length
    ? '\n\nRelevant memories:\n' + memories.slice(0, 10).map((m) => `[${m.category}] ${m.title}: ${m.content.slice(0, 200)}`).join('\n')
    : ''

  // Build system prompt: [userPrompt] \n\n [soul] \n\n [systemPrompt] \n\n [orchestrator context]
  const settings = loadSettings()
  const promptParts: string[] = []
  if (settings.userPrompt) promptParts.push(settings.userPrompt)
  if (orchestrator.soul) promptParts.push(orchestrator.soul)
  if (orchestrator.systemPrompt) promptParts.push(orchestrator.systemPrompt)
  if (orchestrator.skillIds?.length) {
    const allSkills = loadSkills()
    for (const skillId of orchestrator.skillIds) {
      const skill = allSkills[skillId]
      if (skill?.content) promptParts.push(`## Skill: ${skill.name}\n${skill.content}`)
    }
  }
  const basePrompt = promptParts.join('\n\n')

  const systemPrompt = [
    basePrompt,
    '\n\nYou are an orchestrator agent. You can delegate tasks to these agents:',
    agentList || '(no agents available)',
    '\n\nTo delegate a task, output a JSON block on its own line:',
    '{"delegate": {"agent": "agent-name", "task": "what to do"}}',
    '\n\nTo store something in memory:',
    '{"memory_store": {"category": "keyword", "title": "...", "content": "..."}}',
    '\n\nTo read memories:',
    '{"memory_read": {"query": "search terms"}}',
    '\n\nAgents with [tools: browser] have access to a Playwright browser and can navigate websites, scrape data, fill forms, take screenshots, and interact with web pages.',
    '\n\nWhen you are done, output: {"done": true, "summary": "what was accomplished"}',
    memoryContext,
  ].join('\n')

  // Conversation loop
  const conversationHistory: { role: string; text: string }[] = []
  conversationHistory.push({ role: 'user', text: task })

  let result = ''

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const fullText = await callProvider(orchestrator, systemPrompt, conversationHistory)
    conversationHistory.push({ role: 'assistant', text: fullText })

    // Save to session
    session.messages.push({ role: 'user' as const, text: turn === 0 ? task : '[system response]', time: Date.now() })
    session.messages.push({ role: 'assistant' as const, text: fullText, time: Date.now() })
    session.lastActiveAt = Date.now()
    const s = loadSessions()
    s[sessionId] = session
    saveSessions(s)

    // Parse JSON commands from the response
    const commands = extractJsonCommands(fullText)
    let hasDelegate = false

    for (const cmd of commands) {
      if (cmd.delegate) {
        hasDelegate = true
        const agent = agents.find((a) => a.name.toLowerCase() === cmd.delegate.agent.toLowerCase())
        if (!agent) {
          conversationHistory.push({
            role: 'user',
            text: `[System] Agent "${cmd.delegate.agent}" not found. Available agents: ${agents.map((a) => a.name).join(', ')}`,
          })
          continue
        }

        // Execute sub-task
        const subResult = await executeSubTask(agent, cmd.delegate.task, sessionId)
        conversationHistory.push({
          role: 'user',
          text: `[Agent ${agent.name} result]:\n${subResult}`,
        })
      }

      if (cmd.memory_store) {
        db.add({
          agentId: orchestrator.id,
          sessionId,
          category: cmd.memory_store.category || 'note',
          title: cmd.memory_store.title || 'Untitled',
          content: cmd.memory_store.content || '',
        })
        conversationHistory.push({
          role: 'user',
          text: '[System] Memory stored successfully.',
        })
      }

      if (cmd.memory_read) {
        const results = db.search(cmd.memory_read.query, orchestrator.id)
        const memText = results.length
          ? results.map((m) => `[${m.category}] ${m.title}: ${m.content.slice(0, 300)}`).join('\n')
          : 'No matching memories found.'
        conversationHistory.push({
          role: 'user',
          text: `[Memory search results]:\n${memText}`,
        })
      }

      if (cmd.done) {
        result = cmd.summary || fullText
        return result
      }
    }

    if (!hasDelegate && commands.length === 0) {
      // No commands found, treat as final response
      result = fullText
      break
    }
  }

  return result
}

async function executeSubTask(
  agent: Agent,
  task: string,
  parentSessionId: string,
): Promise<string> {
  // Look up parent session cwd to inherit
  const sessions = loadSessions()
  const parentSession = sessions[parentSessionId]
  const childId = crypto.randomBytes(4).toString('hex')
  const childSession = {
    id: childId,
    name: `[Agent] ${agent.name}: ${task.slice(0, 40)}`,
    cwd: parentSession?.cwd || process.cwd(),
    user: 'system',
    provider: agent.provider,
    model: agent.model,
    credentialId: agent.credentialId || null,
    apiEndpoint: agent.apiEndpoint || null,
    claudeSessionId: null,
    messages: [] as any[],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    sessionType: 'orchestrated' as const,
    agentId: agent.id,
    parentSessionId,
    tools: agent.tools || [],
  }
  sessions[childId] = childSession
  saveSessions(sessions)

  const history = [{ role: 'user', text: task }]
  const result = await callProvider(agent, agent.systemPrompt, history)

  childSession.messages.push({ role: 'user', text: task, time: Date.now() })
  childSession.messages.push({ role: 'assistant', text: result, time: Date.now() })
  childSession.lastActiveAt = Date.now()
  const s = loadSessions()
  s[childId] = childSession
  saveSessions(s)

  return result
}

export async function callProvider(
  agent: Agent,
  systemPrompt: string,
  history: { role: string; text: string }[],
): Promise<string> {
  const provider = getProvider(agent.provider)
  if (!provider) throw new Error(`Unknown provider: ${agent.provider}`)

  let apiKey: string | null = null
  if (agent.credentialId) {
    const creds = loadCredentials()
    const cred = creds[agent.credentialId]
    if (cred?.encryptedKey) {
      try { apiKey = decryptKey(cred.encryptedKey) } catch { /* ignore */ }
    }
  }

  // Build a mock session for the provider
  const mockSession = {
    id: 'orch-' + crypto.randomBytes(2).toString('hex'),
    provider: agent.provider,
    model: agent.model,
    credentialId: agent.credentialId,
    apiEndpoint: agent.apiEndpoint,
    cwd: process.cwd(),
    tools: agent.tools || [],
    messages: history.map((h) => ({
      role: h.role as 'user' | 'assistant',
      text: h.text,
      time: Date.now(),
    })),
  }

  let fullText = ''
  const { active } = await import('./storage')

  await provider.handler.streamChat({
    session: mockSession,
    message: history[history.length - 1].text,
    apiKey,
    write: (data: string) => {
      // Parse SSE data to extract text
      if (data.startsWith('data: ')) {
        try {
          const event = JSON.parse(data.slice(6))
          if (event.t === 'd' || event.t === 'md' || event.t === 'r') {
            if (event.t === 'd') fullText += event.text || ''
            else fullText = event.text || ''
          }
        } catch { /* ignore */ }
      }
    },
    active,
    loadHistory: () => mockSession.messages,
  })

  return fullText
}

function extractJsonCommands(text: string): any[] {
  const commands: any[] = []
  // Match JSON blocks on their own lines
  const regex = /^\s*(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})\s*$/gm
  let match
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      if (parsed.delegate || parsed.memory_store || parsed.memory_read || parsed.done) {
        commands.push(parsed)
      }
    } catch {
      // Not valid JSON, skip
    }
  }
  return commands
}
