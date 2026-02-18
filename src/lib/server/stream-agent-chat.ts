import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import { buildSessionTools } from './session-tools'
import { loadCredentials, decryptKey, loadSettings, loadAgents, loadSkills } from './storage'
import type { Session, Message } from '@/types'

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
}

export async function streamAgentChat(opts: StreamAgentChatOpts): Promise<string> {
  const { session, message, apiKey, systemPrompt, write, history } = opts

  const llm = buildLLM(session, apiKey)
  const tools = buildSessionTools(session.cwd, session.tools || [])

  // Build stateModifier: [userPrompt] \n\n [soul] \n\n [systemPrompt]
  const settings = loadSettings()
  const stateModifierParts: string[] = []
  if (settings.userPrompt) stateModifierParts.push(settings.userPrompt)
  // Load agent soul if session has an agent
  if (session.agentId) {
    const agents = loadAgents()
    const agent = agents[session.agentId]
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
      } else if (kind === 'on_tool_start') {
        const toolName = event.name || 'unknown'
        const input = event.data?.input
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

  return fullText
}
