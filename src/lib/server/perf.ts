/**
 * Lightweight performance tracing for critical server paths.
 *
 * Emits structured `[perf]` log lines with timing data so workbench tests
 * can measure where time is spent during chat turns, tool calls, queue
 * processing, and storage operations.
 *
 * Usage:
 *   const end = perf.start('chat-execution', 'streamAgentChat', { sessionId })
 *   // ... do work ...
 *   end({ toolCount: 3, tokens: 1200 })
 *
 * Output:
 *   [perf] chat-execution/streamAgentChat 1423ms {sessionId:"abc",toolCount:3,tokens:1200}
 */

interface PerfEntry {
  category: string
  label: string
  durationMs: number
  meta?: Record<string, unknown>
}

type OnEntryCallback = (entry: PerfEntry) => void

// Disabled by default — workbench tests call perf.setEnabled(true) to activate.
// The SWARMCLAW_PERF env var also enables it for CLI-level benchmarking.
let _enabled = process.env.SWARMCLAW_PERF === '1'
let _onEntry: OnEntryCallback | null = null
const _recentEntries: PerfEntry[] = []
const MAX_RECENT = 200

function emitEntry(entry: PerfEntry): void {
  _recentEntries.push(entry)
  if (_recentEntries.length > MAX_RECENT) _recentEntries.shift()

  if (_onEntry) {
    try { _onEntry(entry) } catch { /* listener errors are non-critical */ }
  }

  const metaStr = entry.meta && Object.keys(entry.meta).length > 0
    ? ' ' + JSON.stringify(entry.meta)
    : ''
  console.log(`[perf] ${entry.category}/${entry.label} ${entry.durationMs}ms${metaStr}`)
}

const _noopEnd = () => 0

/**
 * Start a performance measurement. Returns a function that, when called,
 * records the elapsed time and emits a log entry.
 *
 * When perf is disabled (default in production), returns a shared no-op —
 * zero allocation overhead.
 */
function start(
  category: string,
  label: string,
  meta?: Record<string, unknown>,
): (extraMeta?: Record<string, unknown>) => number {
  if (!_enabled) return _noopEnd
  const t0 = performance.now()
  return (extraMeta?: Record<string, unknown>) => {
    const durationMs = Math.round(performance.now() - t0)
    const merged = (meta || extraMeta)
      ? { ...meta, ...extraMeta }
      : undefined
    emitEntry({ category, label, durationMs, meta: merged })
    return durationMs
  }
}

/**
 * Measure an async function. Returns the function's result.
 */
async function measureAsync<T>(
  category: string,
  label: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>,
): Promise<T> {
  const end = start(category, label, meta)
  try {
    const result = await fn()
    end()
    return result
  } catch (err) {
    end({ error: true })
    throw err
  }
}

/**
 * Measure a synchronous function. Returns the function's result.
 */
function measureSync<T>(
  category: string,
  label: string,
  fn: () => T,
  meta?: Record<string, unknown>,
): T {
  const end = start(category, label, meta)
  try {
    const result = fn()
    end()
    return result
  } catch (err) {
    end({ error: true })
    throw err
  }
}

/** Enable/disable perf tracing at runtime. */
function setEnabled(enabled: boolean): void { _enabled = enabled }

/** Check if perf tracing is enabled. */
function isEnabled(): boolean { return _enabled }

/** Register a callback for every perf entry (useful for tests/workbench). */
function onEntry(cb: OnEntryCallback | null): void { _onEntry = cb }

/** Get recent perf entries (ring buffer, max 200). */
function getRecentEntries(): readonly PerfEntry[] { return _recentEntries }

/** Clear the recent entries buffer. */
function clearRecentEntries(): void { _recentEntries.length = 0 }

/**
 * Wrap a Next.js API route handler with perf timing.
 * Usage: export const GET = withApiPerf('GET /api/agents', handler)
 */
function withApiPerf<T extends (...args: unknown[]) => Promise<Response>>(
  label: string,
  handler: T,
): T {
  return (async (...args: unknown[]) => {
    const end = start('api', label)
    try {
      const response = await handler(...args)
      end({ status: response.status })
      return response
    } catch (err) {
      end({ error: true })
      throw err
    }
  }) as T
}

export const perf = {
  start,
  measureAsync,
  measureSync,
  setEnabled,
  isEnabled,
  onEntry,
  getRecentEntries,
  clearRecentEntries,
  withApiPerf,
}

export type { PerfEntry }
