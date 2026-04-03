import type { BuilderNode, BuilderEdge, ValidationError, ValidationWarning } from '../protocol-builder-store'

/**
 * BFS from startId through directed edges. Returns the set of reachable node IDs
 * (including startId itself).
 */
export function getReachableNodes(
  startId: string,
  edges: BuilderEdge[],
  allNodeIds: string[],
): Set<string> {
  const nodeSet = new Set(allNodeIds)
  const reachable = new Set<string>()
  const queue: string[] = [startId]
  reachable.add(startId)

  while (queue.length > 0) {
    const current = queue.shift()!
    for (const edge of edges) {
      if (edge.source === current) {
        const target = edge.target
        if (nodeSet.has(target) && !reachable.has(target)) {
          reachable.add(target)
          queue.push(target)
        }
      }
    }
  }

  return reachable
}

/**
 * Validates the DAG structure of a workflow graph.
 * Returns errors (blocking issues) and warnings (informational).
 */
export function validateDAG(
  nodes: BuilderNode[],
  edges: BuilderEdge[],
): { errors: ValidationError[]; warnings: ValidationWarning[] } {
  if (nodes.length === 0) {
    return { errors: [], warnings: [] }
  }

  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const allNodeIds = nodes.map((n) => n.id)
  const entryNode = nodes[0]

  // Build adjacency sets for quick lookup
  const nodesWithAnyEdge = new Set<string>()
  const nodesWithOutgoing = new Set<string>()

  for (const edge of edges) {
    nodesWithAnyEdge.add(edge.source)
    nodesWithAnyEdge.add(edge.target)
    nodesWithOutgoing.add(edge.source)
  }

  // Orphan detection: nodes not connected to any edge
  // Skip: the entry node (first node), nodes of kind 'complete'
  const orphanNodeIds = new Set<string>()
  for (const node of nodes) {
    if (node.id === entryNode.id) continue
    if (node.data.kind === 'complete') continue
    if (!nodesWithAnyEdge.has(node.id)) {
      orphanNodeIds.add(node.id)
      errors.push({
        nodeId: node.id,
        message: `Node "${node.data.label}" is not connected to any edge`,
      })
    }
  }

  // Unreachable detection: connected nodes not reachable from entry via BFS
  // Don't double-flag orphans
  const reachable = getReachableNodes(entryNode.id, edges, allNodeIds)
  for (const node of nodes) {
    if (node.id === entryNode.id) continue
    if (orphanNodeIds.has(node.id)) continue
    if (!reachable.has(node.id)) {
      errors.push({
        nodeId: node.id,
        message: `Node "${node.data.label}" is not reachable from the entry node`,
      })
    }
  }

  // Branch validation: each branchCase must have a matching outgoing edge
  for (const node of nodes) {
    if (node.data.kind !== 'branch') continue
    const cases = node.data.branchCases ?? []
    for (const branchCase of cases) {
      const hasEdge = edges.some(
        (e) => e.source === node.id && e.data?.branchCaseId === branchCase.id,
      )
      if (!hasEdge) {
        errors.push({
          nodeId: node.id,
          message: `Branch node "${node.data.label}" has case "${branchCase.label}" without a connected edge`,
        })
      }
    }
  }

  // Warnings: nodes with no outgoing edge (except 'complete' kind)
  for (const node of nodes) {
    if (node.data.kind === 'complete') continue
    if (!nodesWithOutgoing.has(node.id)) {
      warnings.push({
        nodeId: node.id,
        message: `Node "${node.data.label}" has no outgoing edge`,
      })
    }
  }

  return { errors, warnings }
}
