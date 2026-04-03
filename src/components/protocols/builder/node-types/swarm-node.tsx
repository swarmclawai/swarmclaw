import { Handle, Position, type NodeProps, type Node } from '@xyflow/react'
import { cn } from '@/lib/utils'
import type { BuilderNodeData } from '@/features/protocols/builder/protocol-builder-store'

export function SwarmNode({ data, selected }: NodeProps<Node<BuilderNodeData>>) {
  return (
    <div
      className={cn(
        'rounded-lg border-2 border-green-500/40 bg-green-500/10 px-4 py-3 shadow-sm min-w-[140px]',
        selected && 'ring-2 ring-blue-500',
      )}
    >
      <Handle type="target" position={Position.Top} />
      <div className="text-sm font-semibold">{data.label}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {data.swarm?.eligibleAgentIds.length || 0} agents
      </div>
      {data.swarm?.claimLimitPerAgent && (
        <div className="text-xs text-muted-foreground">
          Limit: {data.swarm.claimLimitPerAgent}/agent
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}
