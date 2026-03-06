/**
 * Structured retry with exponential backoff for transient tool failures.
 */

export interface RetryOptions {
  maxAttempts?: number
  backoffMs?: number
  retryable?: RegExp[]
  onRetry?: (attempt: number, lastResult: string) => Promise<void> | void
}

const DEFAULT_RETRYABLE: RegExp[] = [
  /timeout/i,
  /ECONNRESET/i,
  /ENOTFOUND/i,
  /429/,
  /503/,
  /rate.?limit/i,
]

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BACKOFF_MS = 2000

function isRetryableError(error: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(error))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wraps a tool handler function with retry logic for transient failures.
 * The wrapped function must return a string (tool output).
 * Retries only when the returned string matches a retryable pattern
 * (tool handlers typically return error strings rather than throwing).
 */
export async function withRetry<TArgs>(
  fn: (args: TArgs) => Promise<string>,
  args: TArgs,
  opts?: RetryOptions,
): Promise<string> {
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const backoffMs = opts?.backoffMs ?? DEFAULT_BACKOFF_MS
  const retryable = opts?.retryable ?? DEFAULT_RETRYABLE

  let lastResult = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = await fn(args)

    // Only retry if the result looks like a retryable error
    if (attempt < maxAttempts && isRetryableError(lastResult, retryable)) {
      await opts?.onRetry?.(attempt, lastResult)
      const delay = backoffMs * Math.pow(2, attempt - 1)
      console.warn(
        `[tool-retry] Attempt ${attempt}/${maxAttempts} matched retryable pattern, retrying in ${delay}ms`,
      )
      await sleep(delay)
      continue
    }
    return lastResult
  }
  return lastResult
}
