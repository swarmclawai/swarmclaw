import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import { loadSessions, saveSessions, loadAgents, loadCredentials, loadSettings, loadSecrets, loadTasks, saveTasks, decryptKey, loadSkills } from './storage'
import { getMemoryDb } from './memory-db'
import crypto from 'crypto'
import type { Agent, LangGraphProvider, TaskComment } from '@/types'

const MAX_RECURSION = 25

const OLLAMA_CLOUD_URL = 'https://ollama.com/v1'
const OLLAMA_LOCAL_URL = 'http://localhost:11434/v1'

function resolveCredential(credentialId: string | null | undefined): string | null {
  if (!credentialId) return null
  const creds = loadCredentials()
  const cred = creds[credentialId]
  if (!cred?.encryptedKey) return null
  try { return decryptKey(cred.encryptedKey) } catch { return null }
}

/** Read the orchestrator engine config from app settings */
function getLangGraphConfig(): { provider: LangGraphProvider; model: string; apiKey: string | null } {
  const settings = loadSettings()
  const provider = (settings.langGraphProvider || 'anthropic') as LangGraphProvider
  const model = settings.langGraphModel || ''
  const apiKey = resolveCredential(settings.langGraphCredentialId)
  return { provider, model, apiKey }
}

function buildLLM(overrideProvider?: LangGraphProvider, overrideModel?: string, overrideApiKey?: string | null, overrideEndpoint?: string | null) {
  const config = getLangGraphConfig()
  const provider = overrideProvider || config.provider
  const apiKey = overrideApiKey !== undefined ? overrideApiKey : config.apiKey
  const model = overrideModel || config.model

  if (provider === 'anthropic') {
    return new ChatAnthropic({
      model: model || 'claude-sonnet-4-6',
      anthropicApiKey: apiKey || undefined,
      maxTokens: 8192,
    })
  }
  if (provider === 'openai') {
    return new ChatOpenAI({
      model: model || 'gpt-4o',
      apiKey: apiKey || undefined,
    })
  }
  // ollama — use explicit endpoint, or cloud when API key present, or local
  const baseURL = overrideEndpoint
    ? `${overrideEndpoint.replace(/\/+$/, '')}/v1`
    : apiKey ? OLLAMA_CLOUD_URL : OLLAMA_LOCAL_URL
  return new ChatOpenAI({
    model: model || 'qwen3.5',
    apiKey: apiKey || 'ollama',
    configuration: { baseURL },
  })
}

/** Resolve secrets available to this orchestrator */
function getSecretsForOrchestrator(orchestratorId: string): { name: string; service: string; value: string }[] {
  const allSecrets = loadSecrets()
  const result: { name: string; service: string; value: string }[] = []
  for (const secret of Object.values(allSecrets) as any[]) {
    const isGlobal = secret.scope === 'global'
    const isScoped = secret.scope === 'agent' && secret.agentIds?.includes(orchestratorId)
    if (isGlobal || isScoped) {
      try {
        const value = decryptKey(secret.encryptedValue)
        result.push({ name: secret.name, service: secret.service, value })
      } catch { /* skip if decrypt fails */ }
    }
  }
  return result
}

function saveMessage(sessionId: string, role: 'user' | 'assistant', text: string) {
  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session) return
  session.messages.push({ role, text, time: Date.now() })
  session.lastActiveAt = Date.now()
  saveSessions(sessions)
}

/** Import the existing sub-task execution from the old orchestrator */
async function executeSubTaskViaCli(agent: Agent, task: string, parentSessionId: string): Promise<string> {
  // Dynamic import to avoid circular deps
  const { callProvider } = await import('./orchestrator')
  const crypto = await import('crypto')
  const { loadSessions: ls, saveSessions: ss } = await import('./storage')

  const sessions = ls()
  const parentSession = sessions[parentSessionId]
  const childId = crypto.randomBytes(4).toString('hex')
  sessions[childId] = {
    id: childId,
    name: `[Agent] ${agent.name}: ${task.slice(0, 40)}`,
    cwd: parentSession?.cwd || process.cwd(),
    user: 'system',
    provider: agent.provider,
    model: agent.model,
    credentialId: agent.credentialId || null,
    apiEndpoint: agent.apiEndpoint || null,
    claudeSessionId: null,
    messages: [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    sessionType: 'orchestrated' as const,
    agentId: agent.id,
    parentSessionId,
    tools: agent.tools || [],
  }
  ss(sessions)

  const result = await callProvider(agent, agent.systemPrompt, [{ role: 'user', text: task }])

  const s2 = ls()
  if (s2[childId]) {
    s2[childId].messages.push({ role: 'user', text: task, time: Date.now() })
    s2[childId].messages.push({ role: 'assistant', text: result, time: Date.now() })
    s2[childId].lastActiveAt = Date.now()
    ss(s2)
  }

  return result
}

export async function executeLangGraphOrchestrator(
  orchestrator: Agent,
  task: string,
  sessionId: string,
): Promise<string> {
  const allAgents = loadAgents()

  // Build available agents list
  const agentIds = orchestrator.subAgentIds || []
  const agents = agentIds.map((id) => allAgents[id]).filter(Boolean) as Agent[]
  const agentListContext = agents.length
    ? '\n\nAvailable agents:\n' + agents.map((a) => {
        const tools = a.tools?.length ? ` [tools: ${a.tools.join(', ')}]` : ''
        const skills = a.skills?.length ? ` [skills: ${a.skills.join(', ')}]` : ''
        return `- ${a.name}: ${a.description}${tools}${skills}`
      }).join('\n')
    : '\n\n(No agents available for delegation.)'

  // Load relevant memories
  const db = getMemoryDb()
  const memories = db.getByAgent(orchestrator.id)
  const memoryContext = memories.length
    ? '\n\nRelevant memories:\n' + memories.slice(0, 10).map((m) => `[${m.category}] ${m.title}: ${m.content.slice(0, 200)}`).join('\n')
    : ''

  // Define tools
  const delegateTool = tool(
    async ({ agentName, task: agentTask }) => {
      const agent = agents.find((a) => a.name.toLowerCase() === agentName.toLowerCase())
      if (!agent) {
        return `Agent "${agentName}" not found. Available: ${agents.map((a) => a.name).join(', ')}`
      }
      console.log(`[orchestrator-lg] Delegating to ${agent.name}: ${agentTask.slice(0, 80)}`)
      saveMessage(sessionId, 'assistant', `[Delegating to ${agent.name}]: ${agentTask}`)
      const result = await executeSubTaskViaCli(agent, agentTask, sessionId)
      saveMessage(sessionId, 'user', `[Agent ${agent.name} result]: ${result.slice(0, 2000)}`)
      return result
    },
    {
      name: 'delegate_to_agent',
      description: 'Delegate a task to one of the available agents. The agent will execute the task and return its result.',
      schema: z.object({
        agentName: z.string().describe('Name of the agent to delegate to'),
        task: z.string().describe('The task description for the agent'),
      }),
    },
  )

  const storeMemoryTool = tool(
    async ({ category, title, content }) => {
      db.add({
        agentId: orchestrator.id,
        sessionId,
        category,
        title,
        content,
      })
      console.log(`[orchestrator-lg] Stored memory: [${category}] ${title}`)
      return 'Memory stored successfully.'
    },
    {
      name: 'store_memory',
      description: 'Store information in long-term memory for future reference.',
      schema: z.object({
        category: z.string().describe('Category keyword (e.g. "seo", "deployment", "finding")'),
        title: z.string().describe('Short descriptive title'),
        content: z.string().describe('The content to remember'),
      }),
    },
  )

  const searchMemoryTool = tool(
    async ({ query }) => {
      const results = db.search(query, orchestrator.id)
      if (!results.length) return 'No matching memories found.'
      return results.map((m) => `[${m.category}] ${m.title}: ${m.content.slice(0, 300)}`).join('\n')
    },
    {
      name: 'search_memory',
      description: 'Search long-term memory for relevant information.',
      schema: z.object({
        query: z.string().describe('Search terms'),
      }),
    },
  )

  const markCompleteTool = tool(
    async ({ summary }) => {
      console.log(`[orchestrator-lg] Marked complete: ${summary.slice(0, 100)}`)
      return `ORCHESTRATION_COMPLETE: ${summary}`
    },
    {
      name: 'mark_complete',
      description: 'Signal that the orchestration task is done. Call this when all work is finished.',
      schema: z.object({
        summary: z.string().describe('Summary of what was accomplished'),
      }),
    },
  )

  // Secrets
  const availableSecrets = getSecretsForOrchestrator(orchestrator.id)

  const getSecretTool = tool(
    async ({ serviceName }) => {
      const match = availableSecrets.find(
        (s) => s.service.toLowerCase() === serviceName.toLowerCase() || s.name.toLowerCase() === serviceName.toLowerCase(),
      )
      if (!match) {
        return `No secret found for "${serviceName}". Available services: ${availableSecrets.map((s) => s.service).join(', ') || 'none'}`
      }
      console.log(`[orchestrator-lg] Retrieved secret for service: ${match.service}`)
      return JSON.stringify({ name: match.name, service: match.service, value: match.value })
    },
    {
      name: 'get_secret',
      description: 'Retrieve a stored credential/secret by service name (e.g. "gmail", "ahrefs"). Returns the decrypted value. Use this when you need API keys or login credentials for external services.',
      schema: z.object({
        serviceName: z.string().describe('The service name or secret name to look up'),
      }),
    },
  )

  // Task board tools
  const commentOnTaskTool = tool(
    async ({ taskId, comment }) => {
      const tasks = loadTasks()
      const t = tasks[taskId]
      if (!t) return `Task "${taskId}" not found.`
      if (!t.comments) t.comments = []
      const c: TaskComment = {
        id: crypto.randomBytes(4).toString('hex'),
        author: orchestrator.name,
        agentId: orchestrator.id,
        text: comment,
        createdAt: Date.now(),
      }
      t.comments.push(c)
      t.updatedAt = Date.now()
      saveTasks(tasks)
      console.log(`[orchestrator-lg] Commented on task "${t.title}": ${comment.slice(0, 80)}`)
      return `Comment added to task "${t.title}".`
    },
    {
      name: 'comment_on_task',
      description: 'Add a comment to a task on the task board. Use this to provide status updates, ask questions, or leave notes for the user.',
      schema: z.object({
        taskId: z.string().describe('The task ID to comment on'),
        comment: z.string().describe('The comment text'),
      }),
    },
  )

  const createTaskTool = tool(
    async ({ title, description: desc }) => {
      const tasks = loadTasks()
      const id = crypto.randomBytes(4).toString('hex')
      tasks[id] = {
        id,
        title,
        description: desc,
        status: 'backlog',
        agentId: orchestrator.id,
        sessionId: null,
        result: null,
        error: null,
        comments: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        queuedAt: null,
        startedAt: null,
        completedAt: null,
      }
      saveTasks(tasks)
      console.log(`[orchestrator-lg] Created backlog task: "${title}" (${id})`)
      return `Task "${title}" created in backlog (id: ${id}). The user can review and queue it.`
    },
    {
      name: 'create_task',
      description: 'Create a new task in the backlog for the user to review. Use this when you identify follow-up work, need user input, or want to suggest next steps.',
      schema: z.object({
        title: z.string().describe('Short task title'),
        description: z.string().describe('Detailed description of what needs to be done'),
      }),
    },
  )

  // Build secrets context for the system prompt
  const secretsContext = availableSecrets.length
    ? '\n\nAvailable secrets (use get_secret tool to retrieve values):\n' + availableSecrets.map((s) => `- ${s.name} (${s.service})`).join('\n')
    : ''

  // Build task context
  const allTasks = loadTasks()
  const taskList = Object.values(allTasks)
  const taskContext = taskList.length
    ? '\n\nCurrent task board:\n' + taskList.slice(0, 20).map((t: any) => `- [${t.status}] "${t.title}" (id: ${t.id})`).join('\n')
    : ''

  // Build LLM using the orchestrator's own provider/model/credentials
  const orchProvider = orchestrator.provider === 'claude-cli' ? 'anthropic' : orchestrator.provider as LangGraphProvider
  const orchApiKey = resolveCredential(orchestrator.credentialId)
  const orchModel = orchestrator.model || undefined
  const orchEndpoint = orchestrator.apiEndpoint || null
  const llm = buildLLM(orchProvider, orchModel, orchApiKey, orchEndpoint)
  // Build system message: [userPrompt] \n\n [soul] \n\n [systemPrompt] \n\n [orchestrator context]
  const settings = loadSettings()
  const promptParts: string[] = []
  if (settings.userPrompt) promptParts.push(settings.userPrompt)
  if (orchestrator.soul) promptParts.push(orchestrator.soul)
  if (orchestrator.systemPrompt) promptParts.push(orchestrator.systemPrompt)
  // Inject dynamic skills
  if (orchestrator.skillIds?.length) {
    const allSkills = loadSkills()
    for (const skillId of orchestrator.skillIds) {
      const skill = allSkills[skillId]
      if (skill?.content) promptParts.push(`## Skill: ${skill.name}\n${skill.content}`)
    }
  }
  const basePrompt = promptParts.join('\n\n')

  const systemMessage = [
    basePrompt,
    '\nYou are an orchestrator. Use the provided tools to delegate tasks to agents, store and search memories, retrieve secrets for external services, and mark tasks complete.',
    '\nAgents with [tools: browser] have access to a Playwright browser and can navigate websites, scrape data, fill forms, take screenshots, and interact with web pages.',
    '\nAgents with [skills: ...] have specialized Claude Code skills. When delegating to them, mention the skill in your task instructions. For example, if an agent has [skills: frontend-design], tell it "Use /frontend-design to build this UI". Available skills: frontend-design (production-grade UI), site-builder (build from spec), site-tester (QA in Chrome), seo-site-auditor (SEO audit), keyword-researcher (keyword research via Ahrefs).',
    '\nWhen delegating to an agent that needs credentials, use get_secret first and include the credential in the task instructions.',
    '\nYou can comment on tasks to provide status updates and create new backlog tasks for follow-up work.',
    '\nAlways call mark_complete when you are done.',
    agentListContext,
    memoryContext,
    secretsContext,
    taskContext,
  ].join('\n')

  const agent = createReactAgent({
    llm,
    tools: [delegateTool, storeMemoryTool, searchMemoryTool, getSecretTool, commentOnTaskTool, createTaskTool, markCompleteTool],
    stateModifier: systemMessage,
  })

  // Save initial user message
  saveMessage(sessionId, 'user', task)

  let finalResult = ''

  try {
    const stream = await agent.stream(
      { messages: [{ role: 'user' as const, content: task }] },
      { recursionLimit: MAX_RECURSION },
    )

    for await (const chunk of stream) {
      // chunk has 'agent' or 'tools' keys with messages arrays
      const agentChunk = (chunk as any).agent
      if (agentChunk?.messages) {
        const msgs = Array.isArray(agentChunk.messages) ? agentChunk.messages : [agentChunk.messages]
        for (const msg of msgs) {
          const text = typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content.map((c: any) => c.text || '').join('')
              : ''
          if (text) {
            finalResult = text
            saveMessage(sessionId, 'assistant', text)
          }
        }
      }
    }
  } catch (err: any) {
    console.error(`[orchestrator-lg] Error:`, err.message)
    saveMessage(sessionId, 'assistant', `[Error] ${err.message}`)
    throw err
  }

  // Extract summary from mark_complete if present
  const completeMatch = finalResult.match(/ORCHESTRATION_COMPLETE:\s*([\s\S]+)/)
  return completeMatch ? completeMatch[1].trim() : finalResult
}
