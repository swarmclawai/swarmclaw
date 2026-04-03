import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'
import type { BuilderEdgeData } from '@/features/protocols/builder/protocol-builder-store'

export function DefaultEdge(props: EdgeProps<BuilderEdgeData>) {
  const { sourceX, sourceY, targetX, targetY, markerEnd, selected } = props
  const [edgePath] = getBezierPath({ sourceX, sourceY, targetX, targetY })

  return (
    <BaseEdge
      path={edgePath}
      markerEnd={markerEnd}
      style={{
        stroke: selected ? '#3b82f6' : '#64748b',
        strokeWidth: selected ? 3 : 2,
      }}
    />
  )
}
