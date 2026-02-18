import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import { loadSettings, loadCredentials, decryptKey } from '@/lib/server/storage'
import type { LangGraphProvider } from '@/types'

const agentSchema = z.object({
  name: z.string().describe('Short name for the agent'),
  description: z.string().describe('One sentence describing what it does'),
  systemPrompt: z.string().describe('Full system prompt — thorough and specific, at least 3-4 paragraphs'),
  isOrchestrator: z.boolean().describe('True only if it needs to coordinate multiple sub-agents'),
})

const GENERATE_PROMPT = `You are a agent generator. The user will describe an AI agent they want to create. Generate a complete agent definition.

Set isOrchestrator to true ONLY if the user describes something that needs to coordinate multiple sub-agents.
Make the systemPrompt detailed and actionable — at least 3-4 paragraphs. Include specific instructions about how the agent should behave, what it should focus on, and how it should format its responses.`

function buildLLM() {
  const settings = loadSettings()
  const provider = (settings.langGraphProvider || 'anthropic') as LangGraphProvider
  const model = settings.langGraphModel || ''
  let apiKey: string | null = null

  if (settings.langGraphCredentialId) {
    const creds = loadCredentials()
    const cred = creds[settings.langGraphCredentialId]
    if (cred?.encryptedKey) {
      try { apiKey = decryptKey(cred.encryptedKey) } catch {}
    }
  }

  if (provider === 'anthropic') {
    return new ChatAnthropic({
      model: model || 'claude-sonnet-4-6',
      anthropicApiKey: apiKey || undefined,
      maxTokens: 4096,
    })
  }
  if (provider === 'openai') {
    return new ChatOpenAI({
      model: model || 'gpt-4o',
      apiKey: apiKey || undefined,
    })
  }
  // ollama
  const baseURL = apiKey ? 'https://ollama.com/v1' : 'http://localhost:11434/v1'
  return new ChatOpenAI({
    model: model || 'qwen3.5',
    apiKey: apiKey || 'ollama',
    configuration: { baseURL },
  })
}

export async function POST(req: Request) {
  const { prompt } = await req.json()
  if (!prompt?.trim()) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 })
  }

  try {
    const llm = buildLLM()
    const structured = llm.withStructuredOutput(agentSchema)
    const result = await structured.invoke([
      { role: 'system' as const, content: GENERATE_PROMPT },
      { role: 'user' as const, content: prompt },
    ])

    return NextResponse.json(result)
  } catch (err: any) {
    console.error('[agent-generate] Error:', err.message)
    // Fallback: try without structured output
    try {
      const llm = buildLLM()
      const response = await llm.invoke([
        { role: 'system' as const, content: GENERATE_PROMPT + '\n\nRespond with ONLY a JSON object (no markdown fences) with fields: name, description, systemPrompt, isOrchestrator.' },
        { role: 'user' as const, content: prompt },
      ])
      const text = typeof response.content === 'string' ? response.content : ''
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        return NextResponse.json({ error: 'Failed to parse AI response' }, { status: 500 })
      }
      const parsed = agentSchema.parse(JSON.parse(jsonMatch[0]))
      return NextResponse.json(parsed)
    } catch (fallbackErr: any) {
      return NextResponse.json({ error: fallbackErr.message || 'Generation failed' }, { status: 500 })
    }
  }
}
