/** Default base URLs for built-in LLM providers */
export const PROVIDER_DEFAULTS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'api.anthropic.com',
  ollama: 'http://localhost:11434',
  ollamaCloud: 'https://ollama.com',
} as const
