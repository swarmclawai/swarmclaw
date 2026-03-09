/** Sentinel value agents return when no outbound reply should be sent */
export const NO_MESSAGE_SENTINEL = 'NO_MESSAGE'

/** Check if an agent response is the NO_MESSAGE sentinel (case-insensitive, trimmed) */
export function isNoMessage(text: string): boolean {
  return text.trim().toUpperCase() === NO_MESSAGE_SENTINEL
}
