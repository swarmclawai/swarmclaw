import { describe, it, expect } from 'vitest'
import type { BuilderNode, BuilderEdge } from '../protocol-builder-store'
import type { ProtocolStepKind } from '../../../../types'
import { getReachableNodes, validateDAG } from './dag-validator'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string, kind: ProtocolStepKind = 'present', label?: string): BuilderNode {
  return {
    id,
    type: 'builderNode',
    position: { x: 0, y: 0 },
    data: {
      label: label ?? id,
      kind,
    },
  } as BuilderNode
}

function makeEdge(source: string, target: string, edgeType: 'default' | 'branch' | 'loop' = 'default'): BuilderEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    data: {
      edgeType,
    },
  } as BuilderEdge
}

// ---------------------------------------------------------------------------
// getReachableNodes
// ---------------------------------------------------------------------------

describe('getReachableNodes', () => {
  it('returns all connected nodes from start', () => {
    const edges: BuilderEdge[] = [
      makeEdge('a', 'b'),
      makeEdge('b', 'c'),
      makeEdge('c', 'd'),
    ]
    const result = getReachableNodes('a', edges, ['a', 'b', 'c', 'd'])
    expect(result).toEqual(new Set(['a', 'b', 'c', 'd']))
  })

  it('excludes disconnected nodes', () => {
    const edges: BuilderEdge[] = [
      makeEdge('a', 'b'),
    ]
    const result = getReachableNodes('a', edges, ['a', 'b', 'c'])
    expect(result.has('c')).toBe(false)
    expect(result).toEqual(new Set(['a', 'b']))
  })
})

// ---------------------------------------------------------------------------
// validateDAG
// ---------------------------------------------------------------------------

describe('validateDAG', () => {
  it('returns empty errors and warnings for an empty graph', () => {
    const { errors, warnings } = validateDAG([], [])
    expect(errors).toHaveLength(0)
    expect(warnings).toHaveLength(0)
  })

  it('valid linear graph has no errors', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c', 'complete')]
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'c')]
    const { errors } = validateDAG(nodes, edges)
    expect(errors).toHaveLength(0)
  })

  it('detects orphan nodes (not connected to any edge)', () => {
    const nodes = [makeNode('entry'), makeNode('orphan', 'present', 'Orphan'), makeNode('end', 'complete')]
    const edges = [makeEdge('entry', 'end')]
    const { errors } = validateDAG(nodes, edges)
    const orphanError = errors.find((e) => e.nodeId === 'orphan')
    expect(orphanError).toBeDefined()
    expect(orphanError?.message).toContain('not connected to any edge')
  })

  it('detects unreachable nodes (connected but not reachable from entry)', () => {
    // 'island' has an edge but points away from entry; entry cannot reach it
    const nodes = [makeNode('entry'), makeNode('middle'), makeNode('island'), makeNode('end', 'complete')]
    const edges = [
      makeEdge('entry', 'middle'),
      makeEdge('middle', 'end'),
      makeEdge('island', 'end'), // island has an edge but isn't reachable from entry
    ]
    const { errors } = validateDAG(nodes, edges)
    const unreachableError = errors.find((e) => e.nodeId === 'island')
    expect(unreachableError).toBeDefined()
    expect(unreachableError?.message).toContain('not reachable from the entry node')
  })

  it('warns about nodes with no outgoing edge', () => {
    const nodes = [makeNode('entry'), makeNode('dead-end', 'present', 'Dead End')]
    const edges = [makeEdge('entry', 'dead-end')]
    const { warnings } = validateDAG(nodes, edges)
    const deadEndWarning = warnings.find((w) => w.nodeId === 'dead-end')
    expect(deadEndWarning).toBeDefined()
    expect(deadEndWarning?.message).toContain('no outgoing edge')
  })

  it('does not warn about complete nodes with no outgoing edge', () => {
    const nodes = [makeNode('entry'), makeNode('done', 'complete', 'Done')]
    const edges = [makeEdge('entry', 'done')]
    const { warnings } = validateDAG(nodes, edges)
    const completeWarning = warnings.find((w) => w.nodeId === 'done')
    expect(completeWarning).toBeUndefined()
  })

  it('detects branch cases without target edges', () => {
    const branchNode: BuilderNode = {
      id: 'branch1',
      type: 'builderNode',
      position: { x: 0, y: 0 },
      data: {
        label: 'My Branch',
        kind: 'branch',
        branchCases: [
          { id: 'case-yes', label: 'Yes', nextStepId: 'nodeYes' },
          { id: 'case-no', label: 'No', nextStepId: 'nodeNo' },
        ],
      },
    } as BuilderNode

    // Only provide an edge for case-yes, not case-no
    const yesEdge: BuilderEdge = {
      id: 'branch1->nodeYes',
      source: 'branch1',
      target: 'nodeYes',
      data: { edgeType: 'branch', branchCaseId: 'case-yes' },
    } as BuilderEdge

    const nodes = [makeNode('entry'), branchNode, makeNode('nodeYes', 'complete'), makeNode('nodeNo', 'complete')]
    const edges = [makeEdge('entry', 'branch1'), yesEdge, makeEdge('nodeYes', 'nodeNo')]

    const { errors } = validateDAG(nodes, edges)
    const branchError = errors.find((e) => e.nodeId === 'branch1' && e.message.includes('No'))
    expect(branchError).toBeDefined()
    // Should not flag case-yes since it has an edge
    const yesError = errors.find((e) => e.nodeId === 'branch1' && e.message.includes('Yes'))
    expect(yesError).toBeUndefined()
  })
})
