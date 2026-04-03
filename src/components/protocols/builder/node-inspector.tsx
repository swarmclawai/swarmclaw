import { useProtocolBuilderStore } from '@/features/protocols/builder/protocol-builder-store'
import { HintTip } from '@/components/shared/hint-tip'

const PHASE_KINDS = new Set([
  'present', 'collect_independent_inputs', 'round_robin',
  'compare', 'decide', 'summarize', 'emit_tasks',
  'dispatch_task', 'dispatch_delegation', 'wait',
])

export function NodeInspector() {
  const selectedNodeId = useProtocolBuilderStore((s) => s.selectedNodeId)
  const nodes = useProtocolBuilderStore((s) => s.nodes)
  const updateNodeData = useProtocolBuilderStore((s) => s.updateNodeData)
  const pushUndo = useProtocolBuilderStore((s) => s.pushUndo)

  const node = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) : null

  if (!node) {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        Select a node to edit properties
      </div>
    )
  }

  const { kind } = node.data

  const update = (data: Parameters<typeof updateNodeData>[1]) => {
    pushUndo()
    updateNodeData(node.id, data)
  }

  return (
    <div className="max-h-[480px] overflow-y-auto rounded-lg border bg-card p-4 shadow-sm">
      <h3 className="mb-3 text-sm font-bold">Node Properties</h3>

      {/* Label */}
      <div className="mb-3">
        <label className="text-xs font-semibold text-muted-foreground">Label</label>
        <input
          type="text"
          value={node.data.label || ''}
          onChange={(e) => update({ label: e.target.value })}
          className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
        />
      </div>

      {/* Kind (read-only) */}
      <div className="mb-3">
        <label className="text-xs font-semibold text-muted-foreground">Kind</label>
        <div className="mt-1 rounded-md bg-muted px-2 py-1 text-sm capitalize">
          {kind.replace(/_/g, ' ')}
        </div>
      </div>

      {/* Instructions (phases + actions) */}
      {PHASE_KINDS.has(kind) && (
        <div className="mb-3">
          <div className="mb-1 flex items-center gap-1">
            <label className="text-xs font-semibold text-muted-foreground">Instructions</label>
            <HintTip text="Guidance for participants or the system during this step" />
          </div>
          <textarea
            value={node.data.instructions || ''}
            onChange={(e) => update({ instructions: e.target.value || null })}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            rows={3}
            placeholder="e.g., 'Present your analysis...'"
          />
        </div>
      )}

      {/* Turn Limit */}
      {PHASE_KINDS.has(kind) && kind !== 'wait' && (
        <div className="mb-3">
          <label className="text-xs font-semibold text-muted-foreground">Max Turns</label>
          <input
            type="number"
            value={node.data.turnLimit ?? ''}
            onChange={(e) => update({ turnLimit: e.target.value ? parseInt(e.target.value) : null })}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            placeholder="Optional"
            min={1}
          />
        </div>
      )}

      {/* Completion Criteria */}
      {['present', 'collect_independent_inputs', 'decide', 'summarize'].includes(kind) && (
        <div className="mb-3">
          <label className="text-xs font-semibold text-muted-foreground">Completion Criteria</label>
          <textarea
            value={node.data.completionCriteria || ''}
            onChange={(e) => update({ completionCriteria: e.target.value || null })}
            className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            rows={2}
            placeholder="e.g., 'All agents have provided input'"
          />
        </div>
      )}

      {/* Task Config (dispatch_task) */}
      {kind === 'dispatch_task' && (
        <>
          <div className="mb-3">
            <label className="text-xs font-semibold text-muted-foreground">Task Title</label>
            <input
              type="text"
              value={node.data.taskConfig?.title || ''}
              onChange={(e) =>
                update({
                  taskConfig: {
                    title: e.target.value,
                    description: node.data.taskConfig?.description || '',
                    agentId: node.data.taskConfig?.agentId,
                  },
                })
              }
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            />
          </div>
          <div className="mb-3">
            <label className="text-xs font-semibold text-muted-foreground">Task Description</label>
            <textarea
              value={node.data.taskConfig?.description || ''}
              onChange={(e) =>
                update({
                  taskConfig: {
                    title: node.data.taskConfig?.title || '',
                    description: e.target.value,
                    agentId: node.data.taskConfig?.agentId,
                  },
                })
              }
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
              rows={2}
            />
          </div>
        </>
      )}

      {/* Delegation Config (dispatch_delegation) */}
      {kind === 'dispatch_delegation' && (
        <>
          <div className="mb-3">
            <label className="text-xs font-semibold text-muted-foreground">Delegate to Agent</label>
            <input
              type="text"
              value={node.data.delegationConfig?.agentId || ''}
              onChange={(e) =>
                update({
                  delegationConfig: {
                    agentId: e.target.value,
                    message: node.data.delegationConfig?.message || '',
                  },
                })
              }
              placeholder="Agent ID"
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            />
          </div>
          <div className="mb-3">
            <label className="text-xs font-semibold text-muted-foreground">Message</label>
            <textarea
              value={node.data.delegationConfig?.message || ''}
              onChange={(e) =>
                update({
                  delegationConfig: {
                    agentId: node.data.delegationConfig?.agentId || '',
                    message: e.target.value,
                  },
                })
              }
              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
              rows={2}
            />
          </div>
        </>
      )}

      {/* Repeat Config */}
      {kind === 'repeat' && (
        <div className="mb-3">
          <label className="text-xs font-semibold text-muted-foreground">Max Iterations</label>
          <input
            type="number"
            value={node.data.repeat?.maxIterations ?? ''}
            onChange={(e) =>
              update({
                repeat: {
                  bodyStepId: node.data.repeat?.bodyStepId || '',
                  maxIterations: parseInt(e.target.value) || 1,
                  exitCondition: node.data.repeat?.exitCondition,
                  onExhausted: node.data.repeat?.onExhausted,
                },
              })
            }
            className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
            min={1}
          />
        </div>
      )}

      {/* Branch Cases (summary) */}
      {kind === 'branch' && (
        <div className="mb-3">
          <label className="text-xs font-semibold text-muted-foreground">Branch Cases</label>
          <div className="mt-1 text-xs text-muted-foreground">
            {node.data.branchCases?.length || 0} case(s) defined
          </div>
        </div>
      )}

      {/* Output Key */}
      <div className="mb-3">
        <label className="text-xs font-semibold text-muted-foreground">Output Key</label>
        <input
          type="text"
          value={node.data.outputKey || ''}
          onChange={(e) => update({ outputKey: e.target.value || null })}
          className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-sm"
          placeholder="Optional key for step output"
        />
      </div>
    </div>
  )
}
