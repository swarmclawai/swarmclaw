import dagre from 'dagre'
import type { Node, Edge } from '@xyflow/react'
import type { BuilderNodeData, BuilderEdgeData } from '../protocol-builder-store'

const NODE_WIDTH = 180
const NODE_HEIGHT = 80
const RANK_SEP = 100
const NODE_SEP = 60

export function getNodeLayout(
  nodes: Node<BuilderNodeData>[],
  edges: Edge<BuilderEdgeData>[],
): Node<BuilderNodeData>[] {
  if (nodes.length === 0) return nodes

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', ranksep: RANK_SEP, nodesep: NODE_SEP })
  g.setDefaultEdgeLabel(() => ({}))

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  return nodes.map((node) => {
    const pos = g.node(node.id)
    if (!pos) return node
    return {
      ...node,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
    }
  })
}
