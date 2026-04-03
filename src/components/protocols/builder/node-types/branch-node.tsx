import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { BuilderNodeData } from '@/features/protocols/builder/protocol-builder-store'

export function BranchNode({ data, selected }: NodeProps<BuilderNodeData>) {
  const cases = data.branchCases || []

  return (
    <div className={cn('relative', selected && 'ring-2 ring-blue-500 rounded')}>
      <Handle type="target" position={Position.Top} />
      <svg width="120" height="100" viewBox="0 0 120 100">
        <polygon
          points="60,5 115,50 60,95 5,50"
          className="fill-amber-500/10 stroke-amber-500/40"
          strokeWidth="2"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <div className="text-xs font-semibold text-center px-4">{data.label}</div>
        <div className="text-[10px] text-muted-foreground">{cases.length} case(s)</div>
      </div>
      {cases.map((bc, idx) => (
        <Handle
          key={bc.id}
          type="source"
          position={Position.Right}
          id={bc.id}
          style={{ top: `${25 + idx * (50 / Math.max(cases.length, 1))}%` }}
        />
      ))}
      <Handle type="source" position={Position.Bottom} id="default" />
    </div>
  )
}
