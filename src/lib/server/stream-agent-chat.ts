import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import { buildSessionTools } from './session-tools'
import { loadCredentials, decryptKey, loadSettings, loadAgents, loadSkills, appendUsage } from './storage'
import { estimateCost } from './cost'
import { getPluginManager } from './plugins'
import type { Session, Message, UsageRecord } from '@/types'

const OLLAMA_CLOUD_URL = 'https://ollama.com/v1'
const OLLAMA_LOCAL_URL = 'http://localhost:11434/v1'
const MAX_RECURSION = 15

function buildLLM(session: Session, apiKey: string | null) {
  const provider = session.provider

  if (provider === 'anthropic') {
    return new ChatAnthropic({
      model: session.model || 'claude-sonnet-4-6',
      anthropicApiKey: apiKey || undefined,
      maxTokens: 8192,
    })
  }
  if (provider === 'openai') {
    return new ChatOpenAI({
      model: session.model || 'gpt-4o',
      apiKey: apiKey || undefined,
    })
  }
  // ollama — uses OpenAI-compatible endpoint
  const baseURL = apiKey ? OLLAMA_CLOUD_URL : (session.apiEndpoint ? `${session.apiEndpoint}/v1` : `${OLLAMA_LOCAL_URL}`)
  return new ChatOpenAI({
    model: session.model || 'qwen3.5',
    apiKey: apiKey || 'ollama',
    configuration: { baseURL },
  })
}

interface StreamAgentChatOpts {
  session: Session
  message: string
  apiKey: string | null
  systemPrompt?: string
  write: (data: string) => void
  history: Message[]
  fallbackCredentialIds?: string[]
}

export async function streamAgentChat(opts: StreamAgentChatOpts): Promise<string> {
  const { session, message, apiKey, systemPrompt, write, history, fallbackCredentialIds } = opts

  // Build LLM with failover support
  const credentialChain = [apiKey]
  if (fallbackCredentialIds?.length) {
    for (const credId of fallbackCredentialIds) {
      try {
        const creds = loadCredentials()
        const cred = creds[credId]
        if (cred?.encryptedKey) {
          credentialChain.push(decryptKey(cred.encryptedKey))
        }
      } catch { /* skip invalid cred */ }
    }
  }
  const llm = buildLLM(session, apiKey)

  // Build stateModifier: [userPrompt] \n\n [soul] \n\n [systemPrompt]
  const settings = loadSettings()
  const stateModifierParts: string[] = []
  if (settings.userPrompt) stateModifierParts.push(settings.userPrompt)
  // Load agent soul if session has an agent
  let agentPlatformAssignScope: 'self' | 'all' = 'self'
  if (session.agentId) {
    const agents = loadAgents()
    const agent = agents[session.agentId]
    agentPlatformAssignScope = agent?.platformAssignScope || 'self'
    if (agent?.soul) stateModifierParts.push(agent.soul)
    // Inject dynamic skills
    if (agent?.skillIds?.length) {
      const allSkills = loadSkills()
      for (const skillId of agent.skillIds) {
        const skill = allSkills[skillId]
        if (skill?.content) stateModifierParts.push(`## Skill: ${skill.name}\n${skill.content}`)
      }
    }
  }
  stateModifierParts.push(systemPrompt || 'You are a helpful AI assistant with access to tools. Use them when appropriate to help the user.')
  const stateModifier = stateModifierParts.join('\n\n')

  const tools = buildSessionTools(session.cwd, session.tools || [], {
    agentId: session.agentId,
    sessionId: session.id,
    platformAssignScope: agentPlatformAssignScope,
  })
  const agent = createReactAgent({ llm, tools, stateModifier })

  // Build message history for context
  const langchainMessages = history
    .slice(-20) // Keep last 20 messages for context
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.text,
    }))

  // Add current message
  langchainMessages.push({ role: 'user' as const, content: message })

  let fullText = ''
  let totalInputTokens = 0
  let totalOutputTokens = 0

  // Plugin hooks: beforeAgentStart
  const pluginMgr = getPluginManager()
  await pluginMgr.runHook('beforeAgentStart', { session, message })

  try {
    const eventStream = agent.streamEvents(
      { messages: langchainMessages },
      { version: 'v2', recursionLimit: MAX_RECURSION },
    )

    for await (const event of eventStream) {
      const kind = event.event

      if (kind === 'on_chat_model_stream') {
        const chunk = event.data?.chunk
        if (chunk?.content) {
          // content can be string or array of content blocks
          const text = typeof chunk.content === 'string'
            ? chunk.content
            : Array.isArray(chunk.content)
              ? chunk.content.map((c: any) => c.text || '').join('')
              : ''
          if (text) {
            fullText += text
            write(`data: ${JSON.stringify({ t: 'd', text })}\n\n`)
          }
        }
      } else if (kind === 'on_llm_end') {
        // Track token usage from LLM responses
        const usage = event.data?.output?.llmOutput?.tokenUsage
          || event.data?.output?.llmOutput?.usage
          || event.data?.output?.usage_metadata
        if (usage) {
          totalInputTokens += usage.promptTokens || usage.input_tokens || 0
          totalOutputTokens += usage.completionTokens || usage.output_tokens || 0
        }
      } else if (kind === 'on_tool_start') {
        const toolName = event.name || 'unknown'
        const input = event.data?.input
        // Plugin hooks: beforeToolExec
        await pluginMgr.runHook('beforeToolExec', { toolName, input })
        write(`data: ${JSON.stringify({
          t: 'tool_call',
          toolName,
          toolInput: typeof input === 'string' ? input : JSON.stringify(input),
        })}\n\n`)
      } else if (kind === 'on_tool_end') {
        const toolName = event.name || 'unknown'
        const output = event.data?.output
        const outputStr = typeof output === 'string'
          ? output
          : output?.content
            ? String(output.content)
            : JSON.stringify(output)
        // Plugin hooks: afterToolExec
        await pluginMgr.runHook('afterToolExec', { toolName, input: null, output: outputStr })
        write(`data: ${JSON.stringify({
          t: 'tool_result',
          toolName,
          toolOutput: outputStr?.slice(0, 2000),
        })}\n\n`)
      }
    }
  } catch (err: any) {
    const errMsg = err.message || String(err)
    write(`data: ${JSON.stringify({ t: 'err', text: errMsg })}\n\n`)
  }

  // Track cost
  const totalTokens = totalInputTokens + totalOutputTokens
  if (totalTokens > 0) {
    const cost = estimateCost(session.model, totalInputTokens, totalOutputTokens)
    const usageRecord: UsageRecord = {
      sessionId: session.id,
      messageIndex: history.length,
      model: session.model,
      provider: session.provider,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens,
      estimatedCost: cost,
      timestamp: Date.now(),
    }
    appendUsage(session.id, usageRecord)
    // Send usage metadata to client
    write(`data: ${JSON.stringify({
      t: 'md',
      text: JSON.stringify({ usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens, estimatedCost: cost } }),
    })}\n\n`)
  }

  // Plugin hooks: afterAgentComplete
  await pluginMgr.runHook('afterAgentComplete', { session, response: fullText })

  return fullText
}
