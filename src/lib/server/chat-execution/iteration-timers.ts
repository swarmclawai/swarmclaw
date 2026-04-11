/**
 * Manages the idle watchdog and required-tool kickoff timers for a
 * single iteration of the agent chat loop.
 */

export interface IterationTimerOpts {
  /** Milliseconds of idle streaming before aborting the iteration. */
  streamIdleStallMs: number
  /**
   * Milliseconds before aborting the initial model prefill phase (before any
   * streaming token arrives). Defaults to `streamIdleStallMs * 2` when unset.
   * Local models with large prompts may need extra time for the prefill pass.
   */
  initialPrefillStallMs?: number
  /** Milliseconds before forcing a required-tool kickoff reminder. */
  requiredToolKickoffMs: number
  /** Whether the early kickoff enforcement is enabled at all. */
  shouldEnforceEarlyRequiredToolKickoff: boolean
}

export class IterationTimers {
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private requiredToolKickoffTimer: ReturnType<typeof setTimeout> | null = null
  private _idleTimedOut = false
  private _requiredToolKickoffTimedOut = false
  private _receivedFirstStreamEvent = false

  constructor(
    private readonly iterationController: AbortController,
    private readonly opts: IterationTimerOpts,
  ) {}

  get idleTimedOut(): boolean { return this._idleTimedOut }
  get requiredToolKickoffTimedOut(): boolean { return this._requiredToolKickoffTimedOut }

  /**
   * Arm the idle watchdog. On the first call (before any streaming tokens
   * arrive), use the longer `initialPrefillStallMs` timeout to allow for
   * model prefill on local providers. Subsequent re-arms use the standard
   * `streamIdleStallMs` timeout.
   */
  armIdleWatchdog(waitingForToolResult: boolean): void {
    this.clearIdleWatchdog()
    if (waitingForToolResult || this.iterationController.signal.aborted) return
    const timeoutMs = this._receivedFirstStreamEvent
      ? this.opts.streamIdleStallMs
      : (this.opts.initialPrefillStallMs ?? this.opts.streamIdleStallMs * 2)
    this._receivedFirstStreamEvent = true
    this.idleTimer = setTimeout(() => {
      this._idleTimedOut = true
      this.iterationController.abort()
    }, timeoutMs)
  }

  clearIdleWatchdog(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  armRequiredToolKickoff(context: {
    iteration: number
    waitingForToolResult: boolean
    hasToolCalls: boolean
  }): void {
    this.clearRequiredToolKickoff()
    if (!this.opts.shouldEnforceEarlyRequiredToolKickoff) return
    if (context.iteration > 0 || context.waitingForToolResult || context.hasToolCalls || this.iterationController.signal.aborted) return
    this.requiredToolKickoffTimer = setTimeout(() => {
      if (context.waitingForToolResult || context.hasToolCalls || this.iterationController.signal.aborted) return
      this._requiredToolKickoffTimedOut = true
      this.iterationController.abort()
    }, this.opts.requiredToolKickoffMs)
  }

  clearRequiredToolKickoff(): void {
    if (this.requiredToolKickoffTimer) {
      clearTimeout(this.requiredToolKickoffTimer)
      this.requiredToolKickoffTimer = null
    }
  }

  clearAll(): void {
    this.clearIdleWatchdog()
    this.clearRequiredToolKickoff()
  }
}
