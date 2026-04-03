import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { BuilderNodeData } from '@/features/protocols/builder/protocol-builder-store'

export function ParallelNode({ data, selected }: NodeProps<BuilderNodeData>) {
  const branchCount = data.parallel?.branches.length || 1

  return (
    <div
      className={cn(
        'rounded-lg border-2 border-pink-500/40 bg-pink-500/10 px-4 py-3 shadow-sm min-w-[140px]',
        selected && 'ring-2 ring-blue-500',
      )}
    >
      <Handle type="target" position={Position.Top} />
      <div className="text-sm font-semibold">{data.label}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {branchCount} parallel {branchCount === 1 ? 'branch' : 'branches'}
      </div>
      {Array.from({ length: branchCount }).map((_, i) => (
        <Handle
          key={i}
          type="source"
          position={Position.Bottom}
          id={`branch-${i}`}
          style={{ left: `${((i + 1) / (branchCount + 1)) * 100}%` }}
        />
      ))}
    </div>
  )
}
