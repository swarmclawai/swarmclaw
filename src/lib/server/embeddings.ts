import { loadSettings, loadCredentials, decryptKey } from './storage'

export async function getEmbedding(text: string): Promise<number[] | null> {
  const settings = loadSettings()
  const provider = settings.embeddingProvider
  if (!provider) return null

  const model = settings.embeddingModel || 'text-embedding-3-small'

  let apiKey: string | null = null
  if (settings.embeddingCredentialId) {
    const creds = loadCredentials()
    const cred = creds[settings.embeddingCredentialId]
    if (cred?.encryptedKey) {
      try { apiKey = decryptKey(cred.encryptedKey) } catch { /* ignore */ }
    }
  }

  try {
    if (provider === 'openai') {
      return await openaiEmbed(text, model, apiKey)
    } else if (provider === 'ollama') {
      return await ollamaEmbed(text, model, settings.langGraphEndpoint)
    }
  } catch (err: any) {
    console.error(`[embeddings] Error computing embedding:`, err.message)
  }

  return null
}

async function openaiEmbed(text: string, model: string, apiKey: string | null): Promise<number[]> {
  if (!apiKey) throw new Error('OpenAI API key required for embeddings')
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: text.slice(0, 8000), // Limit input length
    }),
  })
  if (!res.ok) throw new Error(`OpenAI embeddings API error: ${res.status}`)
  const data = await res.json()
  return data.data[0].embedding
}

async function ollamaEmbed(text: string, model: string, endpoint?: string | null): Promise<number[]> {
  const baseUrl = endpoint || 'http://localhost:11434'
  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: text.slice(0, 8000),
    }),
  })
  if (!res.ok) throw new Error(`Ollama embeddings API error: ${res.status}`)
  const data = await res.json()
  return data.embedding
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dotProduct / denom
}

export function serializeEmbedding(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer)
}

export function deserializeEmbedding(buf: Buffer): number[] {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4))
}
