export interface StreamToolEventLike {
  run_id: string
  metadata?: Record<string, unknown>
}

export function isLangGraphToolNodeMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false
  return metadata.langgraph_node === 'tools'
    || typeof metadata.__pregel_task_id === 'string'
}

export class LangGraphToolEventTracker {
  private readonly acceptedRunIds = new Set<string>()

  acceptStart(event: StreamToolEventLike): boolean {
    if (!isLangGraphToolNodeMetadata(event.metadata)) return false
    this.acceptedRunIds.add(event.run_id)
    return true
  }

  complete(runId: string): boolean {
    if (!this.acceptedRunIds.has(runId)) return false
    this.acceptedRunIds.delete(runId)
    return true
  }

  get pendingCount(): number {
    return this.acceptedRunIds.size
  }

  listPendingRunIds(): string[] {
    return Array.from(this.acceptedRunIds)
  }
}
