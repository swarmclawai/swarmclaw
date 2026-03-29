/**
 * Shared utility for stripping internal metadata that leaks into streamed chat messages.
 *
 * Two categories:
 * 1. Classification JSON — the message classifier emits JSON with known internal keys
 *    that the main LLM sometimes echoes back.
 * 2. Loop detection messages — tool-loop-detection.ts produces warning/error strings
 *    that the LLM echoes verbatim.
 *
 * Importable from both client and server code.
 */

// ---------------------------------------------------------------------------
// Classification JSON
// ---------------------------------------------------------------------------

const INTERNAL_JSON_KEYS = [
  'isDeliverableTask', 'quality_score', 'isBroadGoal',
  'hasHumanSignals', 'explicitToolRequests', 'isResearchSynthesis', 'confidence',
]

export const INTERNAL_KEY_RE = new RegExp(`"(?:${INTERNAL_JSON_KEYS.join('|')})"`)

/**
 * Remove top-level `{ ... }` blocks that contain known internal classification keys.
 * Handles multi-line JSON. Only strips blocks where at least one internal key is present.
 */
export function stripInternalJson(text: string): string {
  return text.replace(
    /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g,
    (match) => INTERNAL_KEY_RE.test(match) ? '' : match,
  )
}

// ---------------------------------------------------------------------------
// Loop detection messages
// ---------------------------------------------------------------------------

/**
 * Matches all known loop detection message patterns from tool-loop-detection.ts.
 *
 * Patterns:
 * - Tool "X" called N times ...
 * - Tool "X" would be called N times ...
 * - Tool "X" is nearing overuse ...
 * - You called "X" N times with identical input ...
 * - "X" would repeat the same input N times ...
 * - "X" is about to repeat the same input N times ...
 * - Circuit breaker: "X" called N times ...
 * - Circuit breaker: "X" would be called N times ...
 * - Polling stall: "X" returned identical output N times ...
 * - Ping-pong: "X" and "Y" are alternating ...
 * - Ping-pong: "X" and "Y" may be stuck ...
 * - Output stagnation: last N / N of the last N ...
 * - Error convergence: N of the last N ...
 */
const LOOP_DETECTION_RE = new RegExp(
  [
    // Tool frequency: called / would be called / nearing overuse
    String.raw`Tool "[^"]*" (?:called|would be called) \d+ times[^\n]*`,
    String.raw`Tool "[^"]*" is nearing overuse[^\n]*`,
    // Generic repeat: "You called" (post-call) / "X" would repeat / is about to repeat (preview)
    String.raw`You called "[^"]*" \d+ times[^\n]*`,
    String.raw`"[^"]*" (?:would repeat the same input|is about to repeat the same input) \d+ times[^\n]*`,
    // Circuit breaker
    String.raw`Circuit breaker: "[^"]*" (?:called|would be called) \d+ times[^\n]*`,
    // Polling stall
    String.raw`Polling stall: "[^"]*" returned identical output \d+ times[^\n]*`,
    // Ping-pong
    String.raw`Ping-pong: "[^"]*" and "[^"]*" (?:are alternating|may be stuck)[^\n]*`,
    // Output stagnation
    String.raw`Output stagnation:[^\n]*`,
    // Error convergence
    String.raw`Error convergence:[^\n]*`,
  ].join('|'),
  'g',
)

/**
 * Matches loop detection messages wrapped in `[Error: ...]` brackets
 * (from the err SSE event handler in use-chat-store.ts).
 */
const LOOP_DETECTION_WRAPPED_RE = /\[Error: (?:Tool "[^"]*" (?:called|would be called) \d+ times|Tool "[^"]*" is nearing overuse|You called "[^"]*" \d+ times|"[^"]*" (?:would repeat the same input|is about to repeat the same input) \d+ times|Circuit breaker: "[^"]*" (?:called|would be called) \d+ times|Polling stall: "[^"]*" returned identical output \d+ times|Ping-pong: "[^"]*" and "[^"]*" (?:are alternating|may be stuck)|Output stagnation:|Error convergence:)[^\]]*\]/g

/** Remove loop detection messages that the LLM echoed from tool error results. */
export function stripLoopDetectionMessages(text: string): string {
  // Strip [Error: ...] wrapped versions first, before the inner regex eats the content
  return text.replace(LOOP_DETECTION_WRAPPED_RE, '').replace(LOOP_DETECTION_RE, '')
}

// ---------------------------------------------------------------------------
// Combined entry point
// ---------------------------------------------------------------------------

/** Strip all internal metadata (classification JSON + loop detection messages). */
export function stripAllInternalMetadata(text: string): string {
  let result = stripInternalJson(text)
  result = stripLoopDetectionMessages(result)
  return result
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
