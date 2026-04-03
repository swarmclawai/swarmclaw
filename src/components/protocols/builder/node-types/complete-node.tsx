import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { BuilderNodeData } from '@/features/protocols/builder/protocol-builder-store'

export function CompleteNode({ data, selected }: NodeProps<BuilderNodeData>) {
  return (
    <div
      className={cn(
        'rounded-full border-2 border-emerald-500/40 bg-emerald-500/10 px-4 py-3 shadow-sm',
        selected && 'ring-2 ring-blue-500',
      )}
    >
      <Handle type="target" position={Position.Top} />
      <div className="text-sm font-semibold text-center">{data.label || 'Complete'}</div>
    </div>
  )
}
