export const OLLAMA_CLOUD_MODEL_SUFFIX = ':cloud'

export function isOllamaCloudModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && /:cloud$/i.test(model.trim())
}

export function stripOllamaCloudModelSuffix(model: string | null | undefined): string {
  if (typeof model !== 'string') return ''
  return model.trim().replace(/:cloud$/i, '')
}
