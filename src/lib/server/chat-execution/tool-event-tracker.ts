export interface StreamToolEventLike {
  run_id: string
  name?: string
  data?: { input?: unknown }
  metadata?: Record<string, unknown>
}

export function isLangGraphToolNodeMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false
  return metadata.langgraph_node === 'tools'
    || typeof metadata.__pregel_task_id === 'string'
}

function toolCallSignature(event: StreamToolEventLike): string {
  const name = event.name || ''
  // Only dedup when we have enough to form a meaningful signature — name
  // is required. Otherwise callers (and tests) that track distinct run ids
  // with no name/input must continue to work as before.
  if (!name) return ''
  const input = event.data?.input
  const inputStr = typeof input === 'string' ? input : JSON.stringify(input ?? '')
  return `${name}:${inputStr}`
}

export class LangGraphToolEventTracker {
  private readonly acceptedRunIds = new Set<string>()
  private readonly suppressedRunIds = new Set<string>()
  // Active signatures -> first accepted run_id. Used to suppress duplicate
  // parallel tool_calls emitted by some open-source models (e.g. Ollama's
  // devstral emits identical tool_calls twice per turn).
  private readonly activeSignatures = new Map<string, string>()

  acceptStart(event: StreamToolEventLike): boolean {
    if (!isLangGraphToolNodeMetadata(event.metadata)) return false
    const signature = toolCallSignature(event)
    if (signature && this.activeSignatures.has(signature)) {
      const firstAcceptedId = this.activeSignatures.get(signature)
      // If the incoming run_id matches the already-accepted one, this is a
      // duplicate start event for the same run — treat as a no-op accept
      // (do not suppress, since we must still acknowledge its completion).
      if (firstAcceptedId === event.run_id) return false
      this.suppressedRunIds.add(event.run_id)
      return false
    }
    if (signature) this.activeSignatures.set(signature, event.run_id)
    this.acceptedRunIds.add(event.run_id)
    return true
  }

  complete(runId: string): boolean {
    if (this.suppressedRunIds.has(runId)) {
      this.suppressedRunIds.delete(runId)
      return false
    }
    if (!this.acceptedRunIds.has(runId)) return false
    this.acceptedRunIds.delete(runId)
    // Clear matching signature so a legitimately-new call with the same args
    // later in the turn is not mistaken for a duplicate.
    for (const [sig, id] of this.activeSignatures) {
      if (id === runId) { this.activeSignatures.delete(sig); break }
    }
    return true
  }

  get pendingCount(): number {
    return this.acceptedRunIds.size
  }

  listPendingRunIds(): string[] {
    return Array.from(this.acceptedRunIds)
  }
}
