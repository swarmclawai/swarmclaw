import { loadAgents, loadSettings, loadCredentials, decryptKey } from './storage'
import { getProvider } from '../providers'

/**
 * Expands a single user query into multiple semantic search variants
 * to improve vector database recall (OpenClaw-style).
 */
export async function expandQuery(query: string): Promise<string[]> {
  const agents = loadAgents()
  const settings = loadSettings()
  const defaultAgent = agents[settings.defaultAgentId]
  if (!defaultAgent) return [query]

  const providerEntry = getProvider(defaultAgent.provider)
  if (!providerEntry?.handler?.streamChat) return [query]

  const creds = loadCredentials()
  const cred = creds[defaultAgent.credentialId || '']
  const apiKey = cred ? decryptKey(cred.encryptedKey) : undefined

  const systemPrompt = `You are a search query expansion assistant. 
Given a user's question, generate 3 different semantic search queries that would help find the answer in a vector database.
Use different vocabulary and focus on different aspects of the intent.
Format your response as a simple newline-separated list. No numbering, no bullets, no introduction.`

  let expanded = ''
  try {
    await providerEntry.handler.streamChat({
      session: { id: 'expansion', messages: [], model: defaultAgent.model, provider: defaultAgent.provider },
      message: query,
      apiKey,
      systemPrompt,
      write: (raw: string) => {
        const lines = raw.split('\n').filter(Boolean)
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const ev = JSON.parse(line.slice(6))
            if (ev.t === 'd' && ev.text) expanded += ev.text
          } catch { /* skip */ }
        }
      },
      active: new Map(),
      loadHistory: () => [],
    })

    const variants = expanded.split('\n').map(l => l.trim()).filter(Boolean)
    if (variants.length > 0) {
      // Return original query + variants
      return [query, ...variants.slice(0, 3)]
    }
  } catch (err) {
    console.error('[query-expansion] Failed to expand query:', err)
  }

  return [query]
}
