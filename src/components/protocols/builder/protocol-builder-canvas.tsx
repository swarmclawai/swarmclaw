'use client'

import { useCallback, useMemo, type DragEvent } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  applyEdgeChanges,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useProtocolBuilderStore, type BuilderNodeData } from '@/features/protocols/builder/protocol-builder-store'
import { getNodeTypeForKind } from '@/features/protocols/builder/utils/template-to-nodes'
import { PhaseNode, BranchNode, LoopNode, ParallelNode, JoinNode, ForEachNode, SubflowNode, SwarmNode, CompleteNode } from './node-types'
import { DefaultEdge, BranchEdge, LoopEdge } from './edge-types'
import { NodePalette } from './node-palette'
import { NodeInspector } from './node-inspector'
import { ValidationPanel } from './validation-panel'
import type { ProtocolStepKind } from '@/types'

const nodeTypes = {
  phase: PhaseNode,
  branch: BranchNode,
  loop: LoopNode,
  parallel: ParallelNode,
  join: JoinNode,
  forEach: ForEachNode,
  subflow: SubflowNode,
  swarm: SwarmNode,
  complete: CompleteNode,
}

const edgeTypes = {
  default: DefaultEdge,
  branch: BranchEdge,
  loop: LoopEdge,
}

export function ProtocolBuilderCanvas() {
  const nodes = useProtocolBuilderStore((s) => s.nodes)
  const edges = useProtocolBuilderStore((s) => s.edges)
  const setNodes = useProtocolBuilderStore((s) => s.setNodes)
  const setEdges = useProtocolBuilderStore((s) => s.setEdges)
  const selectNode = useProtocolBuilderStore((s) => s.selectNode)
  const selectEdge = useProtocolBuilderStore((s) => s.selectEdge)
  const addNode = useProtocolBuilderStore((s) => s.addNode)
  const addEdge = useProtocolBuilderStore((s) => s.addEdge)
  const pushUndo = useProtocolBuilderStore((s) => s.pushUndo)
  const isDirty = useProtocolBuilderStore((s) => s.isDirty)
  const undo = useProtocolBuilderStore((s) => s.undo)
  const redo = useProtocolBuilderStore((s) => s.redo)

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<BuilderNodeData>>[]) => {
      setNodes(applyNodeChanges(changes, nodes))
    },
    [nodes, setNodes],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setEdges(applyEdgeChanges(changes, edges))
    },
    [edges, setEdges],
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      pushUndo()
      addEdge({
        id: `${connection.source}--${connection.target}--${Date.now()}`,
        source: connection.source!,
        target: connection.target!,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
        type: 'default',
        data: { edgeType: 'default' },
      })
    },
    [addEdge, pushUndo],
  )

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      selectNode(node.id)
    },
    [selectNode],
  )

  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: { id: string }) => {
      selectEdge(edge.id)
    },
    [selectEdge],
  )

  const onPaneClick = useCallback(() => {
    selectNode(null)
    selectEdge(null)
  }, [selectNode, selectEdge])

  const onDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      const kind = e.dataTransfer.getData('application/x-protocol-node-kind') as ProtocolStepKind
      const label = e.dataTransfer.getData('application/x-protocol-node-label')
      if (!kind) return

      pushUndo()

      const nodeData: BuilderNodeData = { label: label || kind, kind }
      const newNode: Node<BuilderNodeData> = {
        id: crypto.randomUUID(),
        type: getNodeTypeForKind(kind),
        position: { x: e.nativeEvent.offsetX - 70, y: e.nativeEvent.offsetY - 30 },
        data: nodeData,
      }
      addNode(newNode)
    },
    [addNode, pushUndo],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
    },
    [undo, redo],
  )

  const memoizedNodeTypes = useMemo(() => nodeTypes, [])
  const memoizedEdgeTypes = useMemo(() => edgeTypes, [])

  return (
    <div className="flex h-full w-full gap-3" onKeyDown={onKeyDown} tabIndex={0}>
      <NodePalette />
      <div className="relative flex-1 overflow-hidden rounded-lg border">
        {isDirty && (
          <div className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-500">
            Unsaved changes
          </div>
        )}
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={memoizedNodeTypes}
          edgeTypes={memoizedEdgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={onPaneClick}
          onDragOver={onDragOver}
          onDrop={onDrop}
          fitView
          deleteKeyCode="Delete"
          defaultEdgeOptions={{ type: 'default', data: { edgeType: 'default' } }}
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
      <div className="flex w-72 flex-col gap-3">
        <NodeInspector />
        <ValidationPanel />
      </div>
    </div>
  )
}
