import type { Node, Edge } from '@xyflow/react'
import type { ProtocolTemplate, ProtocolStepKind, ProtocolStepDefinition, ProtocolPhaseDefinition } from '@/types'
import type { BuilderNodeData, BuilderEdgeData } from '../protocol-builder-store'

export function getNodeTypeForKind(kind: ProtocolStepKind): string {
  switch (kind) {
    case 'branch':
      return 'branch'
    case 'repeat':
      return 'loop'
    case 'parallel':
      return 'parallel'
    case 'join':
      return 'join'
    case 'for_each':
      return 'forEach'
    case 'subflow':
      return 'subflow'
    case 'swarm_claim':
      return 'swarm'
    case 'complete':
      return 'complete'
    default:
      // All ProtocolPhaseKind values map to 'phase'
      return 'phase'
  }
}

function stepToNode(step: ProtocolStepDefinition): Node<BuilderNodeData> {
  return {
    id: step.id,
    type: getNodeTypeForKind(step.kind),
    position: { x: 0, y: 0 },
    data: {
      label: step.label,
      kind: step.kind,
      instructions: step.instructions ?? null,
      turnLimit: step.turnLimit ?? null,
      completionCriteria: step.completionCriteria ?? null,
      taskConfig: step.taskConfig ?? null,
      delegationConfig: step.delegationConfig ?? null,
      repeat: step.repeat ?? null,
      parallel: step.parallel ?? null,
      join: step.join ?? null,
      forEach: step.forEach ?? null,
      subflow: step.subflow ?? null,
      swarm: step.swarm ?? null,
      branchCases: step.branchCases,
      defaultNextStepId: step.defaultNextStepId ?? null,
      outputKey: step.outputKey ?? null,
      dependsOnStepIds: step.dependsOnStepIds,
    },
  }
}

function phaseToNode(phase: ProtocolPhaseDefinition): Node<BuilderNodeData> {
  return {
    id: phase.id,
    type: getNodeTypeForKind(phase.kind),
    position: { x: 0, y: 0 },
    data: {
      label: phase.label,
      kind: phase.kind,
      instructions: phase.instructions ?? null,
      turnLimit: phase.turnLimit ?? null,
      completionCriteria: phase.completionCriteria ?? null,
      taskConfig: phase.taskConfig ?? null,
      delegationConfig: phase.delegationConfig ?? null,
    },
  }
}

export interface TemplateToNodesResult {
  nodes: Node<BuilderNodeData>[]
  edges: Edge<BuilderEdgeData>[]
}

export function templateToNodes(template: ProtocolTemplate): TemplateToNodesResult {
  const useSteps = Array.isArray(template.steps) && template.steps.length > 0

  if (!useSteps) {
    // Fall back to defaultPhases — phases have no edge wiring defined, so connect them sequentially
    const nodes = template.defaultPhases.map(phaseToNode)
    const edges: Edge<BuilderEdgeData>[] = []

    for (let i = 0; i < template.defaultPhases.length - 1; i++) {
      const source = template.defaultPhases[i]
      const target = template.defaultPhases[i + 1]
      edges.push({
        id: `${source.id}--${target.id}`,
        source: source.id,
        target: target.id,
        type: 'default',
        data: { edgeType: 'default' },
      })
    }

    return { nodes, edges }
  }

  const steps = template.steps!
  const nodes = steps.map(stepToNode)
  const edges: Edge<BuilderEdgeData>[] = []

  for (const step of steps) {
    // Default next step edge
    if (step.nextStepId) {
      edges.push({
        id: `${step.id}--${step.nextStepId}`,
        source: step.id,
        target: step.nextStepId,
        type: 'default',
        data: { edgeType: 'default' },
      })
    }

    // Branch case edges
    if (step.branchCases && step.branchCases.length > 0) {
      for (const branchCase of step.branchCases) {
        edges.push({
          id: `${step.id}--${branchCase.id}`,
          source: step.id,
          target: branchCase.nextStepId,
          sourceHandle: branchCase.id,
          type: 'branch',
          label: branchCase.label,
          data: {
            edgeType: 'branch',
            branchCaseId: branchCase.id,
            label: branchCase.label,
          },
        })
      }
    }

    // Default branch edge (for branch steps)
    if (step.defaultNextStepId) {
      edges.push({
        id: `${step.id}--default`,
        source: step.id,
        target: step.defaultNextStepId,
        sourceHandle: 'default',
        type: 'branch',
        label: 'Default',
        data: {
          edgeType: 'branch',
          label: 'Default',
        },
      })
    }

    // Loop body edge
    if (step.repeat?.bodyStepId) {
      edges.push({
        id: `${step.id}--loop`,
        source: step.id,
        target: step.repeat.bodyStepId,
        sourceHandle: 'loop-back',
        type: 'loop',
        data: {
          edgeType: 'loop',
          isLoopback: true,
        },
      })
    }
  }

  return { nodes, edges }
}
