export function normalizeOllamaSetupEndpoint(endpoint: string, useCloud: boolean): string {
  const normalized = endpoint.replace(/\/+$/, '')
  if (useCloud) return normalized
  return normalized.replace(/\/v1$/i, '')
}

export async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return fallback
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.error?.message === 'string' && parsed.error.message.trim()) return parsed.error.message.trim()
    if (typeof parsed?.error === 'string' && parsed.error.trim()) return parsed.error.trim()
    if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message.trim()
    if (typeof parsed?.detail === 'string' && parsed.detail.trim()) return parsed.detail.trim()
  } catch {
    // Non-JSON response body.
  }
  return text.slice(0, 300).trim() || fallback
}

export function normalizeOpenClawUrl(raw: string): { httpUrl: string; wsUrl: string } {
  let url = (raw || 'http://localhost:18789').replace(/\/+$/, '')
  if (!/^(https?|wss?):\/\//i.test(url)) url = `http://${url}`
  const httpUrl = url.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:')
  const wsUrl = httpUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')
  return { httpUrl, wsUrl }
}
