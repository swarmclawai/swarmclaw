/** Minimum new-character delta required between tool_summary retries. */
export const TOOL_SUMMARY_PROGRESS_MIN_DELTA = 30

/**
 * Returns false when a prior tool_summary retry already ran and the model
 * has produced essentially no additional text on the follow-up turn — the
 * signal to stop retrying. On the first pass (priorLen < 0) this is always
 * true so the retry can happen at least once.
 */
export function toolSummaryHasMeaningfulProgress(priorLen: number, currentLen: number): boolean {
  if (priorLen < 0) return true
  return currentLen - priorLen >= TOOL_SUMMARY_PROGRESS_MIN_DELTA
}
