import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { Node, Edge } from '@xyflow/react'
import type { ProtocolTemplate, ProtocolStepKind, ProtocolBranchCase, ProtocolRepeatConfig, ProtocolParallelConfig, ProtocolJoinConfig, ProtocolForEachConfig, ProtocolSubflowConfig, ProtocolSwarmConfig, ProtocolRunStepStatus } from '@/types'

export interface BuilderNodeData extends Record<string, unknown> {
  label: string
  kind: ProtocolStepKind
  instructions?: string | null
  turnLimit?: number | null
  completionCriteria?: string | null
  taskConfig?: { agentId?: string; title: string; description: string } | null
  delegationConfig?: { agentId: string; message: string } | null
  repeat?: ProtocolRepeatConfig | null
  parallel?: ProtocolParallelConfig | null
  join?: ProtocolJoinConfig | null
  forEach?: ProtocolForEachConfig | null
  subflow?: ProtocolSubflowConfig | null
  swarm?: ProtocolSwarmConfig | null
  branchCases?: ProtocolBranchCase[]
  defaultNextStepId?: string | null
  outputKey?: string | null
  dependsOnStepIds?: string[]
  runtimeStatus?: ProtocolRunStepStatus | null
}

export interface BuilderEdgeData extends Record<string, unknown> {
  edgeType: 'default' | 'branch' | 'loop'
  branchCaseId?: string | null
  label?: string | null
  isLoopback?: boolean
}

export interface ValidationError {
  nodeId?: string
  edgeId?: string
  message: string
}

export interface ValidationWarning {
  nodeId?: string
  message: string
}

export type BuilderNode = Node<BuilderNodeData>
export type BuilderEdge = Edge<BuilderEdgeData>

interface UndoSnapshot {
  nodes: BuilderNode[]
  edges: BuilderEdge[]
}

const MAX_UNDO_HISTORY = 50

export interface ProtocolBuilderState {
  nodes: BuilderNode[]
  edges: BuilderEdge[]
  selectedNodeId: string | null
  selectedEdgeId: string | null
  isPaletteOpen: boolean
  isInspectorOpen: boolean
  currentTemplate: ProtocolTemplate | null
  isDirty: boolean
  validationErrors: ValidationError[]
  validationWarnings: ValidationWarning[]
  undoStack: UndoSnapshot[]
  redoStack: UndoSnapshot[]
  activeRunId: string | null

  setNodes: (nodes: BuilderNode[]) => void
  setEdges: (edges: BuilderEdge[]) => void
  selectNode: (nodeId: string | null) => void
  selectEdge: (edgeId: string | null) => void
  updateNodeData: (nodeId: string, data: Partial<BuilderNodeData>) => void
  updateEdgeData: (edgeId: string, data: Partial<BuilderEdgeData>) => void
  addNode: (node: BuilderNode) => void
  deleteNode: (nodeId: string) => void
  addEdge: (edge: BuilderEdge) => void
  deleteEdge: (edgeId: string) => void
  loadTemplate: (template: ProtocolTemplate, nodes: BuilderNode[], edges: BuilderEdge[]) => void
  setValidation: (errors: ValidationError[], warnings: ValidationWarning[]) => void
  setActiveRun: (runId: string | null) => void
  setDirty: (dirty: boolean) => void
  pushUndo: () => void
  undo: () => void
  redo: () => void
  setPaletteOpen: (open: boolean) => void
  setInspectorOpen: (open: boolean) => void
  reset: () => void
}

const initialState = {
  nodes: [] as BuilderNode[],
  edges: [] as BuilderEdge[],
  selectedNodeId: null,
  selectedEdgeId: null,
  isPaletteOpen: true,
  isInspectorOpen: true,
  currentTemplate: null,
  isDirty: false,
  validationErrors: [] as ValidationError[],
  validationWarnings: [] as ValidationWarning[],
  undoStack: [] as UndoSnapshot[],
  redoStack: [] as UndoSnapshot[],
  activeRunId: null,
}

export const useProtocolBuilderStore = create<ProtocolBuilderState>()(
  devtools(
    (set, get) => ({
      ...initialState,

      setNodes: (nodes) => set({ nodes, isDirty: true }),
      setEdges: (edges) => set({ edges, isDirty: true }),

      selectNode: (nodeId) =>
        set({ selectedNodeId: nodeId, selectedEdgeId: null }),

      selectEdge: (edgeId) =>
        set({ selectedEdgeId: edgeId, selectedNodeId: null }),

      updateNodeData: (nodeId, data) => {
        const { nodes } = get()
        set({
          nodes: nodes.map((n) =>
            n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n,
          ),
          isDirty: true,
        })
      },

      updateEdgeData: (edgeId, data) => {
        const { edges } = get()
        set({
          edges: edges.map((e) =>
            e.id === edgeId ? { ...e, data: { ...e.data, ...data } as BuilderEdgeData } : e,
          ),
          isDirty: true,
        })
      },

      addNode: (node) => {
        const { nodes } = get()
        set({ nodes: [...nodes, node], isDirty: true })
      },

      deleteNode: (nodeId) => {
        const { nodes, edges } = get()
        set({
          nodes: nodes.filter((n) => n.id !== nodeId),
          edges: edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
          selectedNodeId: null,
          isDirty: true,
        })
      },

      addEdge: (edge) => {
        const { edges } = get()
        set({ edges: [...edges, edge], isDirty: true })
      },

      deleteEdge: (edgeId) => {
        const { edges } = get()
        set({
          edges: edges.filter((e) => e.id !== edgeId),
          selectedEdgeId: null,
          isDirty: true,
        })
      },

      loadTemplate: (template, nodes, edges) =>
        set({
          currentTemplate: template,
          nodes,
          edges,
          isDirty: false,
          validationErrors: [],
          validationWarnings: [],
          undoStack: [],
          redoStack: [],
          selectedNodeId: null,
          selectedEdgeId: null,
        }),

      setValidation: (errors, warnings) =>
        set({ validationErrors: errors, validationWarnings: warnings }),

      setActiveRun: (runId) => set({ activeRunId: runId }),
      setDirty: (dirty) => set({ isDirty: dirty }),

      pushUndo: () => {
        const { nodes, edges, undoStack } = get()
        const snapshot: UndoSnapshot = { nodes: [...nodes], edges: [...edges] }
        const trimmed = undoStack.length >= MAX_UNDO_HISTORY
          ? undoStack.slice(1)
          : undoStack
        set({ undoStack: [...trimmed, snapshot], redoStack: [] })
      },

      undo: () => {
        const { undoStack, nodes, edges } = get()
        if (undoStack.length === 0) return
        const prev = undoStack[undoStack.length - 1]
        set({
          nodes: prev.nodes,
          edges: prev.edges,
          undoStack: undoStack.slice(0, -1),
          redoStack: [{ nodes, edges }, ...get().redoStack],
          isDirty: true,
        })
      },

      redo: () => {
        const { redoStack, nodes, edges } = get()
        if (redoStack.length === 0) return
        const next = redoStack[0]
        set({
          nodes: next.nodes,
          edges: next.edges,
          redoStack: redoStack.slice(1),
          undoStack: [...get().undoStack, { nodes, edges }],
          isDirty: true,
        })
      },

      setPaletteOpen: (open) => set({ isPaletteOpen: open }),
      setInspectorOpen: (open) => set({ isInspectorOpen: open }),

      reset: () => set(initialState),
    }),
    { name: 'protocol-builder' },
  ),
)
