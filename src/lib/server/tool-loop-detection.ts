/**
 * Tool loop detection.
 *
 * Four detectors run on every on_tool_end event:
 * 1. Generic repeat    — same (name, inputHash) seen N+ times
 * 2. Polling stall     — repeated poll-like calls with identical output
 * 3. Ping-pong         — two tools alternating with identical results
 * 4. Circuit breaker   — absolute cap on identical calls regardless of type
 *
 * Each detector returns a severity: 'ok' | 'warning' | 'critical'.
 * The caller decides what to do (log, inject guidance, abort).
 */

import { createHash } from 'crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallRecord {
  name: string
  inputHash: string
  outputHash: string
  /** first 200 chars of output for logging */
  outputPreview: string
  timestamp: number
}

export type LoopSeverity = 'ok' | 'warning' | 'critical'

export interface LoopDetectionResult {
  severity: LoopSeverity
  detector: 'generic_repeat' | 'polling_stall' | 'ping_pong' | 'circuit_breaker' | 'tool_frequency'
  message: string
}

export interface LoopDetectionThresholds {
  /** Generic repeat: warn after this many identical (name, input) calls. Default 6. */
  repeatWarn: number
  /** Generic repeat: critical after this many. Default 12. */
  repeatCritical: number
  /** Polling stall: warn after N poll-like calls with identical output. Default 4. */
  pollWarn: number
  /** Polling stall: critical after this many. Default 8. */
  pollCritical: number
  /** Ping-pong: how many alternating-pair cycles trigger warning. Default 3. */
  pingPongWarn: number
  /** Ping-pong: critical after this many cycles. Default 5. */
  pingPongCritical: number
  /** Circuit breaker: absolute cap on any identical call. Default 20. */
  circuitBreaker: number
  /** Per-tool frequency: warn after this many calls to the same tool (any input). Default 5. */
  toolFrequencyWarn: number
  /** Per-tool frequency: critical after this many calls to the same tool (any input). Default 8. */
  toolFrequencyCritical: number
}

const DEFAULT_THRESHOLDS: LoopDetectionThresholds = {
  repeatWarn: 20,
  repeatCritical: 40,
  pollWarn: 20,
  pollCritical: 40,
  pingPongWarn: 20,
  pingPongCritical: 40,
  circuitBreaker: 60,
  toolFrequencyWarn: 150,
  toolFrequencyCritical: 300,
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

function quickHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

export function hashToolInput(input: unknown): string {
  const str = typeof input === 'string' ? input : JSON.stringify(input ?? '')
  return quickHash(str)
}

export function hashToolOutput(output: unknown): string {
  const str = typeof output === 'string' ? output : JSON.stringify(output ?? '')
  return quickHash(str)
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

export class ToolLoopTracker {
  private history: ToolCallRecord[] = []
  private thresholds: LoopDetectionThresholds

  constructor(thresholds?: Partial<LoopDetectionThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds }
  }

  /** Record a completed tool call and run all detectors. */
  record(name: string, input: unknown, output: unknown): LoopDetectionResult | null {
    const inputHash = hashToolInput(input)
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output ?? '')
    const outputHash = hashToolOutput(output)
    const record: ToolCallRecord = {
      name,
      inputHash,
      outputHash,
      outputPreview: outputStr.slice(0, 200),
      timestamp: Date.now(),
    }
    this.history.push(record)

    // Run detectors in severity order (most severe first)
    return this.checkCircuitBreaker(record)
      ?? this.checkToolFrequency(record)
      ?? this.checkGenericRepeat(record)
      ?? this.checkPollingStall(record)
      ?? this.checkPingPong()
      ?? null
  }

  /** Get the full call history (for diagnostics). */
  getHistory(): ReadonlyArray<ToolCallRecord> {
    return this.history
  }

  /** Total recorded calls. */
  get size(): number {
    return this.history.length
  }

  // -------------------------------------------------------------------------
  // Detectors
  // -------------------------------------------------------------------------

  private checkToolFrequency(current: ToolCallRecord): LoopDetectionResult | null {
    let count = 0
    for (const r of this.history) {
      if (r.name === current.name) count++
    }
    if (count >= this.thresholds.toolFrequencyCritical) {
      return {
        severity: 'critical',
        detector: 'tool_frequency',
        message: `Tool "${current.name}" called ${count} times this turn. Excessive repetition — wrap up with available results.`,
      }
    }
    if (count >= this.thresholds.toolFrequencyWarn) {
      return {
        severity: 'warning',
        detector: 'tool_frequency',
        message: `Tool "${current.name}" called ${count} times. Consider whether more calls are needed.`,
      }
    }
    return null
  }

  private checkCircuitBreaker(current: ToolCallRecord): LoopDetectionResult | null {
    const key = `${current.name}:${current.inputHash}`
    let count = 0
    for (const r of this.history) {
      if (`${r.name}:${r.inputHash}` === key) count++
    }
    if (count >= this.thresholds.circuitBreaker) {
      return {
        severity: 'critical',
        detector: 'circuit_breaker',
        message: `Circuit breaker: "${current.name}" called ${count} times with identical input. Halting to prevent runaway.`,
      }
    }
    return null
  }

  private checkGenericRepeat(current: ToolCallRecord): LoopDetectionResult | null {
    const key = `${current.name}:${current.inputHash}`
    let count = 0
    for (const r of this.history) {
      if (`${r.name}:${r.inputHash}` === key) count++
    }
    if (count >= this.thresholds.repeatCritical) {
      return {
        severity: 'critical',
        detector: 'generic_repeat',
        message: `Tool "${current.name}" has been called ${count} times with the same input. This appears to be a stuck loop.`,
      }
    }
    if (count >= this.thresholds.repeatWarn) {
      return {
        severity: 'warning',
        detector: 'generic_repeat',
        message: `Tool "${current.name}" has been called ${count} times with the same input. Consider a different approach.`,
      }
    }
    return null
  }

  private checkPollingStall(current: ToolCallRecord): LoopDetectionResult | null {
    // Look for recent sequential calls to the same tool with identical output
    const recent = this.history.slice(-this.thresholds.pollCritical)
    const pollRuns = recent.filter(
      (r) => r.name === current.name && r.outputHash === current.outputHash,
    )
    if (pollRuns.length >= this.thresholds.pollCritical) {
      return {
        severity: 'critical',
        detector: 'polling_stall',
        message: `Polling stall: "${current.name}" returned identical output ${pollRuns.length} times consecutively. The polled resource is not changing.`,
      }
    }
    if (pollRuns.length >= this.thresholds.pollWarn) {
      return {
        severity: 'warning',
        detector: 'polling_stall',
        message: `Polling stall: "${current.name}" returned identical output ${pollRuns.length} times. The state may not be progressing.`,
      }
    }
    return null
  }

  private checkPingPong(): LoopDetectionResult | null {
    const len = this.history.length
    if (len < 4) return null

    // Check if the last N calls form an A-B-A-B pattern with identical results
    const last = this.history[len - 1]
    const prev = this.history[len - 2]
    if (last.name === prev.name) return null // same tool — not ping-pong

    let cycles = 0
    for (let i = len - 2; i >= 1; i -= 2) {
      const a = this.history[i]
      const b = this.history[i - 1]
      if (
        a.name === last.name && a.outputHash === last.outputHash
        && b.name === prev.name && b.outputHash === prev.outputHash
      ) {
        cycles++
      } else {
        break
      }
    }

    if (cycles >= this.thresholds.pingPongCritical) {
      return {
        severity: 'critical',
        detector: 'ping_pong',
        message: `Ping-pong: "${prev.name}" and "${last.name}" are alternating with identical results (${cycles} cycles). Breaking the loop.`,
      }
    }
    if (cycles >= this.thresholds.pingPongWarn) {
      return {
        severity: 'warning',
        detector: 'ping_pong',
        message: `Ping-pong: "${prev.name}" and "${last.name}" may be stuck in an alternating loop (${cycles} cycles).`,
      }
    }
    return null
  }
}
