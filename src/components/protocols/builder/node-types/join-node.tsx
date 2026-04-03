import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { BuilderNodeData } from '@/features/protocols/builder/protocol-builder-store'

export function JoinNode({ data, selected }: NodeProps<BuilderNodeData>) {
  return (
    <div
      className={cn(
        'rounded-full border-2 border-pink-500/40 bg-pink-500/10 px-4 py-2 shadow-sm',
        selected && 'ring-2 ring-blue-500',
      )}
    >
      <Handle type="target" position={Position.Top} />
      <div className="text-xs font-semibold text-center">{data.label || 'Join'}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
