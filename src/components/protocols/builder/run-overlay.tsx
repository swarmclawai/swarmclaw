import { useProtocolBuilderStore } from '@/features/protocols/builder/protocol-builder-store'
import { useProtocolRunDetailQuery } from '@/features/protocols/queries'

export function RunOverlay() {
  const activeRunId = useProtocolBuilderStore((s) => s.activeRunId)
  const nodes = useProtocolBuilderStore((s) => s.nodes)
  const { data: runDetail } = useProtocolRunDetailQuery(activeRunId)

  if (!runDetail) return null

  const { run } = runDetail
  const currentNode = run.currentStepId
    ? nodes.find((n) => n.id === run.currentStepId)
    : null

  return (
    <div className="absolute left-4 top-4 z-50 rounded-lg border border-blue-500/30 bg-card p-3 shadow-lg">
      <div className="text-sm font-semibold">{run.title}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        Status: <span className="font-semibold capitalize">{run.status}</span>
      </div>
      {currentNode && (
        <div className="mt-1 text-xs text-muted-foreground">
          Current: {currentNode.data.label}
        </div>
      )}
    </div>
  )
}
