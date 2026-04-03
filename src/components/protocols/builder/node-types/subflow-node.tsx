import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { BuilderNodeData } from '@/features/protocols/builder/protocol-builder-store'

export function SubflowNode({ data, selected }: NodeProps<BuilderNodeData>) {
  return (
    <div
      className={cn(
        'rounded-lg border-2 border-violet-500/40 bg-violet-500/10 px-4 py-3 shadow-md min-w-[140px]',
        selected && 'ring-2 ring-blue-500',
      )}
    >
      <Handle type="target" position={Position.Top} />
      <div className="text-sm font-semibold">{data.label}</div>
      {data.subflow?.templateId && (
        <div className="mt-1 text-xs text-muted-foreground truncate max-w-[130px]">
          Template: {data.subflow.templateId}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
