import { BaseEdge, getBezierPath, type EdgeProps, type Edge } from '@xyflow/react'
import type { BuilderEdgeData } from '@/features/protocols/builder/protocol-builder-store'

export function BranchEdge(props: EdgeProps<Edge<BuilderEdgeData>>) {
  const { sourceX, sourceY, targetX, targetY, markerEnd, selected, data } = props
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY })

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: selected ? '#f59e0b' : '#d97706',
          strokeWidth: selected ? 3 : 2,
        }}
      />
      {data?.label && (
        <foreignObject
          x={labelX - 30}
          y={labelY - 10}
          width={60}
          height={20}
          className="pointer-events-none"
        >
          <div className="rounded border border-amber-500/30 bg-background px-1 py-0.5 text-center text-[10px] font-semibold text-amber-600">
            {data.label}
          </div>
        </foreignObject>
      )}
    </>
  )
}
