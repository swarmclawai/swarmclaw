import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'
import type { BuilderEdgeData } from '@/features/protocols/builder/protocol-builder-store'

export function LoopEdge(props: EdgeProps<BuilderEdgeData>) {
  const { sourceX, sourceY, targetX, targetY, markerEnd, selected } = props
  const [edgePath] = getBezierPath({ sourceX, sourceY, targetX, targetY })

  return (
    <BaseEdge
      path={edgePath}
      markerEnd={markerEnd}
      style={{
        stroke: selected ? '#06b6d4' : '#0d9488',
        strokeWidth: selected ? 3 : 2,
        strokeDasharray: '5,5',
      }}
    />
  )
}
