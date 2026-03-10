import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import { StateGraph, MessagesAnnotation, START, END } from '@langchain/langgraph'
import { ToolNode } from '@langchain/langgraph/prebuilt'
import { AIMessage } from '@langchain/core/messages'
import { loadSessions, saveSessions, loadAgents, loadCredentials, loadSettings, loadSecrets, loadTasks, patchTask, upsertTask, decryptKey, loadSkills } from '@/lib/server/storage'
import { WORKSPACE_DIR } from '@/lib/server/data-dir'
import { loadRuntimeSettings, getOrchestratorLoopRecursionLimit } from '@/lib/server/runtime/runtime-settings'
import { getMemoryDb } from '@/lib/server/memory/memory-db'
import { buildChatModel } from '@/lib/server/build-llm'
import { getCheckpointSaver } from '@/lib/server/langgraph-checkpoint'
import { buildCurrentDateTimePromptContext } from '@/lib/server/prompt-runtime-context'
import { getPluginManager } from '@/lib/server/plugins'
import { buildBoardTask } from '@/lib/server/tasks/task-lifecycle'
import '@/lib/server/builtin-plugins'
import { genId } from '@/lib/id'
import { NON_LANGGRAPH_PROVIDER_IDS } from '@/lib/provider-sets'
import type { Agent, TaskComment, MessageToolEvent } from '@/types'

function resolveCredential(credentialId: string | null | undefined): string | null {
  if (!credentialId) return null
  const creds = loadCredentials()
  const cred = creds[credentialId]
  if (!cred?.encryptedKey) return null
  try { return decryptKey(cred.encryptedKey) } catch { return null }
}

/** Resolve which provider/model/key the orchestration routing layer should use */
function getOrchestrationEngineConfig(orchestrator: Agent): { provider: string; model: string; apiKey: string | null; apiEndpoint: string | null } {
  const settings = loadSettings()
  const configuredProvider = typeof settings.langGraphProvider === 'string'
    ? settings.langGraphProvider.trim()
    : ''
  const configuredModel = typeof settings.langGraphModel === 'string'
    ? settings.langGraphModel.trim()
    : ''
  const configuredApiKey = resolveCredential(settings.langGraphCredentialId)
  const configuredEndpoint = typeof settings.langGraphEndpoint === 'string' && settings.langGraphEndpoint.trim()
    ? settings.langGraphEndpoint.trim()
    : null

  const fallbackProvider = orchestrator.provider === 'claude-cli' ? 'anthropic' : orchestrator.provider
  const fallbackModel = orchestrator.model || ''
  const fallbackApiKey = resolveCredential(orchestrator.credentialId)
  const fallbackEndpoint = orchestrator.apiEndpoint || null

  const useConfiguredEngine = configuredProvider.length > 0 && !NON_LANGGRAPH_PROVIDER_IDS.has(configuredProvider)

  if (useConfiguredEngine) {
    return {
      provider: configuredProvider,
      model: configuredModel,
      apiKey: configuredApiKey,
      apiEndpoint: configuredEndpoint,
    }
  }

  return {
    provider: fallbackProvider,
    model: fallbackModel,
    apiKey: fallbackApiKey,
    apiEndpoint: fallbackEndpoint,
  }
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

function saveMessage(sessionId: string, role: 'user' | 'assistant', text: string, toolEvents?: MessageToolEvent[]) {
  const sessions = loadSessions()
  const session = sessions[sessionId]
  if (!session) return
  session.messages.push({ role, text, time: Date.now(), ...(toolEvents?.length ? { toolEvents } : {}) })
  session.lastActiveAt = Date.now()
  saveSessions(sessions)
}

/** Import the existing sub-task execution from the old orchestrator */
async function executeSubTaskViaCli(agent: Agent, task: string, parentSessionId: string): Promise<string> {
  // Dynamic import to avoid circular deps
  const { callProvider } = await import('@/lib/server/agents/orchestrator')
  const { loadSessions: ls, saveSessions: ss } = await import('@/lib/server/storage')

  const sessions = ls()
  const parentSession = sessions[parentSessionId]
  const childId = genId()
  sessions[childId] = {
    id: childId,
    name: `[Agent] ${agent.name}: ${task.slice(0, 40)}`,
    cwd: parentSession?.cwd || WORKSPACE_DIR,
    user: 'system',
    provider: agent.provider,
    model: agent.model,
    credentialId: agent.credentialId || null,
    apiEndpoint: agent.apiEndpoint || null,
    claudeSessionId: null,
    codexThreadId: null,
    opencodeSessionId: null,
    delegateResumeIds: {
      claudeCode: null,
      codex: null,
      opencode: null,
      gemini: null,
    },
    messages: [],
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    sessionType: 'human' as const,
    agentId: agent.id,
    parentSessionId,
    plugins: agent.plugins || agent.tools || [],
  }
  ss(sessions)

  // Build system prompt with identity
  const subPromptParts: string[] = []
  subPromptParts.push(`## My Identity\nMy name is ${agent.name}.${agent.description ? ' ' + agent.description : ''} I should always refer to myself by this name.`)
  if (agent.soul) subPromptParts.push(agent.soul)
  if (agent.systemPrompt) subPromptParts.push(agent.systemPrompt)
  const result = await callProvider(agent, subPromptParts.join('\n\n'), [{ role: 'user', text: task }])

  const s2 = ls()
  if (s2[childId]) {
    s2[childId].messages.push({ role: 'user', text: task, time: Date.now() })
    s2[childId].messages.push({ role: 'assistant', text: result, time: Date.now() })
    s2[childId].lastActiveAt = Date.now()
    ss(s2)
  }

  return result
}

function createOrchestratorTools(params: {
  orchestrator: Agent
  agents: Agent[]
  sessionId: string
  availableSecrets: Array<{ name: string; service: string; value: string }>
}) {
  const { orchestrator, agents, sessionId, availableSecrets } = params
  const db = getMemoryDb()

  const delegateTool = tool(
    async ({ agentName, task: agentTask }) => {
      const agent = agents.find((candidate) => candidate.name.toLowerCase() === agentName.toLowerCase())
      if (!agent) {
        return `Agent "${agentName}" not found. Available: ${agents.map((candidate) => candidate.name).join(', ')}`
      }
      console.log(`[orchestrator-lg] Delegating to ${agent.name}: ${agentTask.slice(0, 80)}`)
      getPluginManager().runHook(
        'onAgentDelegation',
        { sourceAgentId: orchestrator.id, targetAgentId: agent.id, task: agentTask },
        { enabledIds: orchestrator.plugins || [] },
      )
      const result = await executeSubTaskViaCli(agent, agentTask, sessionId)
      saveMessage(sessionId, 'assistant', `Delegated to ${agent.name}: ${agentTask.slice(0, 100)}`, [{
        name: 'delegate_to_agent',
        input: JSON.stringify({ agentName: agent.name, agentId: agent.id, task: agentTask }),
        output: result.slice(0, 2000),
      }])
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
      return results.map((memory) => `[${memory.category}] ${memory.title}: ${memory.content.slice(0, 300)}`).join('\n')
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

  const getSecretTool = tool(
    async ({ serviceName }) => {
      const match = availableSecrets.find(
        (secret) => secret.service.toLowerCase() === serviceName.toLowerCase() || secret.name.toLowerCase() === serviceName.toLowerCase(),
      )
      if (!match) {
        return `No secret found for "${serviceName}". Available services: ${availableSecrets.map((secret) => secret.service).join(', ') || 'none'}`
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

  const commentOnTaskTool = tool(
    async ({ taskId, comment }) => {
      const t = patchTask(taskId, (current) => {
        if (!current) return current
        if (!current.comments) current.comments = []
        const nextComment: TaskComment = {
          id: genId(),
          author: orchestrator.name,
          agentId: orchestrator.id,
          text: comment,
          createdAt: Date.now(),
        }
        current.comments.push(nextComment)
        current.updatedAt = Date.now()
        return current
      })
      if (!t) return `Task "${taskId}" not found.`
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
      const now = Date.now()
      const taskRecord = buildBoardTask({
        title,
        description: desc,
        agentId: orchestrator.id,
        now,
        seed: {
          comments: [],
        },
      })
      upsertTask(taskRecord.id, taskRecord)
      console.log(`[orchestrator-lg] Created backlog task: "${title}" (${taskRecord.id})`)
      return `Task "${title}" created in backlog (id: ${taskRecord.id}). The user can review and queue it.`
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

  return [delegateTool, storeMemoryTool, searchMemoryTool, getSecretTool, commentOnTaskTool, createTaskTool, markCompleteTool]
}

function compileOrchestratorGraph(params: {
  llmWithTools: any
  allTools: ReturnType<typeof createOrchestratorTools>
  checkpointSaver: any
  systemMessage?: string
  enableDelegateFallback?: boolean
}) {
  const { llmWithTools, allTools, checkpointSaver, systemMessage, enableDelegateFallback = false } = params
  const toolNode = new ToolNode(allTools)
  let fallbackAttempts = 0
  const maxFallbackAttempts = 2

  async function agentNode(state: typeof MessagesAnnotation.State) {
    const promptMessages = systemMessage
      ? [{ role: 'system' as const, content: systemMessage }, ...state.messages]
      : state.messages
    const response = await llmWithTools.invoke(promptMessages)
    return { messages: [response] }
  }

  function routerNode(state: typeof MessagesAnnotation.State) {
    if (!enableDelegateFallback) return { messages: [] }
    const messages = state.messages
    const lastMsg = messages[messages.length - 1]
    if (lastMsg && typeof (lastMsg as any).content === 'string') {
      const content = (lastMsg as any).content as string
      const isError = content.startsWith('Error:') || content.startsWith('Agent "') && content.includes('not found')
      if (isError && fallbackAttempts < maxFallbackAttempts) {
        fallbackAttempts++
        const failedToolCall = [...messages].reverse().find(
          (message) => (message as any).tool_calls?.some((toolCall: any) => toolCall.name === 'delegate_to_agent'),
        )
        if (failedToolCall) {
          const toolCall = (failedToolCall as any).tool_calls?.find((entry: any) => entry.name === 'delegate_to_agent')
          const failedAgentName = toolCall?.args?.agentName || 'unknown'
          const fallbackHint = `The agent "${failedAgentName}" failed. Try delegating to a different agent with matching capabilities, or re-plan your approach. Fallback attempt ${fallbackAttempts}/${maxFallbackAttempts}.`
          return { messages: [new AIMessage({ content: fallbackHint })] }
        }
      }
    }
    return { messages: [] }
  }

  function shouldContinue(state: typeof MessagesAnnotation.State) {
    const lastMsg = state.messages[state.messages.length - 1]
    const toolCalls = (lastMsg as any)?.tool_calls
    return toolCalls && toolCalls.length > 0 ? 'tools' : END
  }

  function afterRouter() {
    return 'agent'
  }

  const graph = new StateGraph(MessagesAnnotation)
    .addNode('agent', agentNode)
    .addNode('tools', toolNode)
    .addNode('router', routerNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue, { tools: 'tools', [END]: END })
    .addEdge('tools', 'router')
    .addConditionalEdges('router', afterRouter, { agent: 'agent' })

  const compiledGraph = graph.compile({
    checkpointer: checkpointSaver,
  })

  ;(compiledGraph as any).__graphStructure = {
    nodes: ['agent', 'tools', 'router'],
    edges: [
      { from: START, to: 'agent' },
      { from: 'agent', to: 'tools', condition: 'has_tool_calls' },
      { from: 'agent', to: END, condition: 'no_tool_calls' },
      { from: 'tools', to: 'router' },
      { from: 'router', to: 'agent', condition: enableDelegateFallback ? 'fallback_or_continue' : 'continue' },
    ],
  }

  return compiledGraph
}

export async function executeLangGraphOrchestrator(
  orchestrator: Agent,
  task: string,
  sessionId: string,
  taskId?: string,
): Promise<string> {
  const allAgents = loadAgents()

  // Build available agents list
  const agentIds = orchestrator.subAgentIds || []
  const agents = agentIds.map((id) => allAgents[id]).filter(Boolean) as Agent[]
  const agentListContext = agents.length
    ? '\n\nAvailable agents:\n' + agents.map((a) => {
        const plugins = (a.plugins || a.tools)?.length ? ` [plugins: ${(a.plugins || a.tools)!.join(', ')}]` : ''
        const skills = a.skills?.length ? ` [skills: ${a.skills.join(', ')}]` : ''
        return `- ${a.name}: ${a.description}${plugins}${skills}`
      }).join('\n')
    : '\n\n(No agents available for delegation.)'

  // Load relevant memories
  const db = getMemoryDb()
  const memories = db.getByAgent(orchestrator.id)
  const memoryContext = memories.length
    ? '\n\nRelevant memories:\n' + memories.slice(0, 10).map((m) => `[${m.category}] ${m.title}: ${m.content.slice(0, 200)}`).join('\n')
    : ''

  // Secrets
  const availableSecrets = getSecretsForOrchestrator(orchestrator.id)
  const allTools = createOrchestratorTools({
    orchestrator,
    agents,
    sessionId,
    availableSecrets,
  })

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

  // Build routing LLM from Settings -> Orchestrator Engine (fallback: orchestrator's own provider)
  const engine = getOrchestrationEngineConfig(orchestrator)
  const llm = buildChatModel({
    provider: engine.provider,
    model: engine.model,
    apiKey: engine.apiKey,
    apiEndpoint: engine.apiEndpoint,
  })
  // Build system message: [identity] \n\n [userPrompt] \n\n [soul] \n\n [systemPrompt] \n\n [orchestrator context]
  const settings = loadSettings()
  const promptParts: string[] = []
  // Identity block
  const orchIdentity = [`## My Identity`, `My name is ${orchestrator.name}.`]
  if (orchestrator.description) orchIdentity.push(orchestrator.description)
  orchIdentity.push('I should always refer to myself by this name.')
  promptParts.push(orchIdentity.join(' '))
  if (settings.userPrompt) promptParts.push(settings.userPrompt)
  promptParts.push(buildCurrentDateTimePromptContext())
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

  const checkpointSaver = getCheckpointSaver()
  const llmWithTools = llm.bindTools(allTools)
  const compiledGraph = compileOrchestratorGraph({
    llmWithTools,
    allTools,
    checkpointSaver,
    systemMessage,
    enableDelegateFallback: true,
  })

  // Save initial user message
  saveMessage(sessionId, 'user', task)

  let finalResult = ''
  const runtime = loadRuntimeSettings()
  const recursionLimit = getOrchestratorLoopRecursionLimit(runtime)
  const abortController = new AbortController()
  let timedOut = false
  const loopTimer = runtime.loopMode === 'ongoing' && runtime.ongoingLoopMaxRuntimeMs
    ? setTimeout(() => {
        timedOut = true
        abortController.abort()
      }, runtime.ongoingLoopMaxRuntimeMs)
    : null

  try {
    const threadId = taskId || sessionId
    const streamConfig = {
      recursionLimit,
      signal: abortController.signal,
      configurable: { thread_id: threadId },
    }
    const stream = await compiledGraph.stream(
      { messages: [{ role: 'user' as const, content: task }] },
      streamConfig,
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
    const errMsg = timedOut
      ? 'Ongoing loop stopped after reaching the configured runtime limit.'
      : err.message || String(err)
    console.error(`[orchestrator-lg] Error:`, errMsg)
    saveMessage(sessionId, 'assistant', `[Error] ${errMsg}`)
    throw new Error(errMsg)
  } finally {
    if (loopTimer) clearTimeout(loopTimer)
  }

  // Extract summary from mark_complete if present
  const completeMatch = finalResult.match(/ORCHESTRATION_COMPLETE:\s*([\s\S]+)/)
  const summary = completeMatch ? completeMatch[1].trim() : finalResult
  
  return summary
}

/**
 * Resume a paused orchestrator run after human approval.
 * Re-creates the same agent graph and streams from the saved checkpoint.
 */
export async function resumeLangGraphOrchestrator(
  orchestrator: Agent,
  sessionId: string,
  threadId: string,
): Promise<string> {
  const allAgents = loadAgents()
  const agentIds = orchestrator.subAgentIds || []
  const agents = agentIds.map((id) => allAgents[id]).filter(Boolean) as Agent[]
  const availableSecrets = getSecretsForOrchestrator(orchestrator.id)
  const allTools = createOrchestratorTools({
    orchestrator,
    agents,
    sessionId,
    availableSecrets,
  })

  const engine = getOrchestrationEngineConfig(orchestrator)
  const llm = buildChatModel({
    provider: engine.provider, model: engine.model,
    apiKey: engine.apiKey, apiEndpoint: engine.apiEndpoint,
  })

  const checkpointSaver = getCheckpointSaver()

  const llmWithTools = llm.bindTools(allTools)
  const graphAgent = compileOrchestratorGraph({
    llmWithTools,
    allTools,
    checkpointSaver,
  })

  let finalResult = ''
  const runtime = loadRuntimeSettings()
  const recursionLimit = getOrchestratorLoopRecursionLimit(runtime)

  try {
    // Resume from checkpoint with null input — the checkpoint has the full state
    const stream = await graphAgent.stream(null, {
      recursionLimit,
      configurable: { thread_id: threadId },
    })

    for await (const chunk of stream) {
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
    console.error(`[orchestrator-lg] Resume error:`, err.message || String(err))
    saveMessage(sessionId, 'assistant', `[Error] ${err.message || String(err)}`)
    throw err
  }

  const completeMatch = finalResult.match(/ORCHESTRATION_COMPLETE:\s*([\s\S]+)/)
  return completeMatch ? completeMatch[1].trim() : finalResult
}
