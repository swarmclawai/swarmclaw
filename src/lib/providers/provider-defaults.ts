/** Default base URLs for built-in LLM providers */
export const PROVIDER_DEFAULTS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'api.anthropic.com',
  ollama: 'http://localhost:11434',
  ollamaCloud: 'https://ollama.com',
} as const

/** File extension patterns shared across provider attachment handlers */
export const IMAGE_EXTS = /\.(png|jpg|jpeg|gif|webp|bmp)$/i
export const TEXT_EXTS = /\.(txt|md|csv|json|xml|html|js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|yml|yaml|toml|env|log|sh|sql|css|scss)$/i

/** Max message history entries sent to providers */
export const MAX_HISTORY_MESSAGES = 40

/** Default max tokens for Anthropic responses */
export const ANTHROPIC_MAX_TOKENS = 8192

/** Max characters to extract from PDFs (OpenAI handler) */
export const PDF_MAX_CHARS = 100_000

/**
 * Write an SSE data frame.  All provider streaming uses this envelope.
 *
 * @example writeSSE(write, 'd', delta)          // text delta
 * @example writeSSE(write, 'err', errMsg)       // error
 * @example writeSSE(write, 'md', jsonPayload)   // metadata
 */
export function writeSSE(write: (data: string) => void, type: string, text: string): void {
  write(`data: ${JSON.stringify({ t: type, text })}\n\n`)
}
