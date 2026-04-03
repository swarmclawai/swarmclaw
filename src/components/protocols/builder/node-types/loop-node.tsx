import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { BuilderNodeData } from '@/features/protocols/builder/protocol-builder-store'

export function LoopNode({ data, selected }: NodeProps<BuilderNodeData>) {
  return (
    <div
      className={cn(
        'rounded-lg border-2 border-teal-500/40 bg-teal-500/10 px-4 py-3 shadow-sm min-w-[140px]',
        selected && 'ring-2 ring-blue-500',
      )}
    >
      <Handle type="target" position={Position.Top} />
      <div className="text-sm font-semibold">{data.label}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        Max: {data.repeat?.maxIterations || '?'} iterations
      </div>
      <Handle type="source" position={Position.Bottom} />
      <Handle type="source" position={Position.Left} id="loop-back" />
    </div>
  )
}
