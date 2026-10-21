export const MINIMAX_OPENAI_BASE_URL = 'https://api.minimax.io/v1'
export const MINIMAX_CN_OPENAI_BASE_URL = 'https://api.minimaxi.com/v1'
export const MINIMAX_ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic'
export const MINIMAX_CN_ANTHROPIC_BASE_URL = 'https://api.minimaxi.com/anthropic'

export type MiniMaxReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export function isMiniMaxAnthropicEndpoint(endpoint: string | null | undefined): boolean {
  return (endpoint || '').trim().replace(/\/+$/, '').toLowerCase().endsWith('/anthropic')
}

export function isMiniMaxFlashModel(model: string | null | undefined): boolean {
  return (model || '').trim().toLowerCase() === 'minimax-m3.1-flash'
}

/**
 * MiniMax M3.1-Flash is adaptive-only. The OpenAI-compatible API uses
 * reasoning_effort, while the Anthropic-compatible API uses output_config.effort.
 * The app's thinking control exposes low/medium/high; an unset value keeps the
 * documented Flash default of max. M3 intentionally receives no effort field.
 */
export function resolveMiniMaxReasoningEffort(
  model: string | null | undefined,
  thinkingLevel: string | null | undefined,
): MiniMaxReasoningEffort | null {
  if (!isMiniMaxFlashModel(model)) return null
  if (thinkingLevel === 'xhigh' || thinkingLevel === 'max') return thinkingLevel
  if (thinkingLevel === 'medium' || thinkingLevel === 'high') return thinkingLevel
  return thinkingLevel === 'low' || thinkingLevel === 'minimal' ? 'low' : 'max'
}
