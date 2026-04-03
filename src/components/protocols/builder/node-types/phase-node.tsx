import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { BuilderNodeData } from '@/features/protocols/builder/protocol-builder-store'

const KIND_STYLES: Record<string, string> = {
  present: 'border-blue-500/40 bg-blue-500/10',
  collect_independent_inputs: 'border-cyan-500/40 bg-cyan-500/10',
  round_robin: 'border-indigo-500/40 bg-indigo-500/10',
  compare: 'border-yellow-500/40 bg-yellow-500/10',
  decide: 'border-orange-500/40 bg-orange-500/10',
  summarize: 'border-purple-500/40 bg-purple-500/10',
  emit_tasks: 'border-green-500/40 bg-green-500/10',
  wait: 'border-zinc-500/40 bg-zinc-500/10',
  dispatch_task: 'border-lime-500/40 bg-lime-500/10',
  dispatch_delegation: 'border-rose-500/40 bg-rose-500/10',
}

const RUNTIME_RING: Record<string, string> = {
  completed: 'ring-2 ring-emerald-500 opacity-60',
  running: 'ring-2 ring-blue-500 animate-pulse',
  failed: 'ring-2 ring-red-500',
  pending: 'opacity-40',
  ready: 'ring-2 ring-amber-400',
}

export function PhaseNode({ data, selected }: NodeProps<Node<BuilderNodeData>>) {
  const style = KIND_STYLES[data.kind] || KIND_STYLES.present
  const runtimeRing = data.runtimeStatus ? RUNTIME_RING[data.runtimeStatus] : ''

  return (
    <div
      className={cn(
        'rounded-lg border-2 px-4 py-3 shadow-sm min-w-[140px]',
        style,
        runtimeRing,
        selected && 'ring-2 ring-blue-500',
      )}
    >
      <Handle type="target" position={Position.Top} />
      <div className="text-sm font-semibold">{data.label}</div>
      <div className="mt-1 text-xs text-muted-foreground capitalize">
        {data.kind.replace(/_/g, ' ')}
      </div>
      {data.turnLimit && (
        <div className="mt-1 text-xs text-muted-foreground">
          Turns: {data.turnLimit}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
