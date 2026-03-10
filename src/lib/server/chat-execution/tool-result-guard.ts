/**
 * Tool Result Size Guards
 *
 * Prevents oversized tool results from blowing out the LLM context window.
 * Uses head+tail truncation with newline-aligned cuts.
 */

/** Absolute hard cap on any single tool result (characters) */
export const HARD_MAX_TOOL_RESULT_CHARS = 80_000

/** No single tool result should consume more than this fraction of the context window */
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3

/** Minimum chars to preserve even with a small context window */
const MIN_KEEP_CHARS = 4_000

/** Chars to check at the tail for important content (errors, JSON closing, summaries) */
const TAIL_SCAN_CHARS = 2_000

const MIDDLE_OMISSION_MARKER =
  '\n\n... [truncated — middle portion omitted to fit context window] ...\n\n'

/**
 * Calculate the maximum tool result size based on context window.
 * Returns the lesser of the hard cap and the context-share-derived limit.
 */
export function calculateMaxToolResultChars(contextWindowTokens: number): number {
  // ~4 chars per token
  const contextShareChars = Math.floor(contextWindowTokens * 4 * MAX_TOOL_RESULT_CONTEXT_SHARE)
  return Math.max(MIN_KEEP_CHARS, Math.min(HARD_MAX_TOOL_RESULT_CHARS, contextShareChars))
}

/**
 * Detect whether the tail of a string contains important content
 * (error messages, JSON closing, summaries) worth preserving.
 */
function hasImportantTail(text: string): boolean {
  const tail = text.slice(-TAIL_SCAN_CHARS)
  // Error patterns at end
  if (/(?:Error|error|ERROR|FAIL|fail|exception|Exception)[:\s]/m.test(tail)) return true
  // JSON/object closing
  if (/[}\]]\s*$/.test(tail)) return true
  // Summary patterns
  if (/(?:summary|result|conclusion|total|completed|success)/i.test(tail)) return true
  return false
}

/**
 * Snap a head cut position backwards to the nearest newline.
 * Only snaps if a newline exists within the last 20% of the budget
 * to avoid losing too much content.
 */
function alignHeadToNewline(text: string, pos: number): number {
  const nl = text.lastIndexOf('\n', pos)
  if (nl > pos * 0.8) return nl
  return pos
}

/**
 * Snap a tail start position forwards to the nearest newline.
 * Only snaps if a newline exists within the first 20% of the tail budget.
 */
function alignTailToNewline(text: string, pos: number): number {
  const nl = text.indexOf('\n', pos)
  const budget = text.length - pos
  if (nl !== -1 && nl < pos + budget * 0.2) return nl + 1
  return pos
}

/**
 * Truncate a tool result string using a head+tail strategy.
 * Preserves the beginning (context/setup) and end (errors/results) of the output,
 * removing the middle portion.
 */
export function truncateToolResultText(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text

  const effectiveMax = Math.max(MIN_KEEP_CHARS, maxChars)
  if (text.length <= effectiveMax) return text

  if (hasImportantTail(text)) {
    // Head + tail strategy: keep beginning and end
    const tailKeep = Math.min(TAIL_SCAN_CHARS, Math.floor(effectiveMax * 0.3))
    const headKeep = effectiveMax - tailKeep - MIDDLE_OMISSION_MARKER.length
    if (headKeep < 500) {
      // Not enough room for meaningful head — just take the tail
      return MIDDLE_OMISSION_MARKER + text.slice(-effectiveMax + MIDDLE_OMISSION_MARKER.length)
    }
    // Align cuts to newline boundaries for cleaner truncation
    const headCut = alignHeadToNewline(text, headKeep)
    const tailStart = alignTailToNewline(text, text.length - tailKeep)
    return text.slice(0, headCut) + MIDDLE_OMISSION_MARKER + text.slice(tailStart)
  }

  // Simple head truncation — align to newline boundary
  const headBudget = effectiveMax - MIDDLE_OMISSION_MARKER.length
  const headCut = alignHeadToNewline(text, headBudget)
  return text.slice(0, headCut) + MIDDLE_OMISSION_MARKER
}
