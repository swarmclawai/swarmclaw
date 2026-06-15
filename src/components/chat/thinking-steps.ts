/** A single parsed reasoning step extracted from a model's thinking text. */
export interface ThinkingStep {
  /** First non-empty line of the step — used as the collapsed summary. */
  firstLine: string
  /** Full step text, including the first line. */
  full: string
  /** Whether the step has more content beyond its first line. */
  hasMore: boolean
}

/**
 * Split a block of reasoning/thinking text into discrete steps.
 *
 * Models emit extended thinking as prose separated by blank lines (paragraphs).
 * Each paragraph is treated as one step. When there are no blank-line breaks the
 * whole text is a single step. The first non-empty line of each step is exposed
 * as a summary so callers can render a one-line-per-step outline.
 */
export function splitThinkingSteps(text: string): ThinkingStep[] {
  const normalized = (text || '').replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const chunks = paragraphs.length > 0 ? paragraphs : [normalized]

  return chunks.map((chunk) => {
    const lines = chunk.split('\n')
    const firstLine = (lines.find((l) => l.trim().length > 0) || chunk).trim()
    const hasMore = chunk.trim().length > firstLine.length
    return { firstLine, full: chunk, hasMore }
  })
}
