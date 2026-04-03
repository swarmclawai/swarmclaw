import type { Node, Edge } from '@xyflow/react'
import type { ProtocolTemplate, ProtocolStepDefinition } from '@/types'
import type { BuilderNodeData, BuilderEdgeData } from '../protocol-builder-store'

export function nodesToTemplate(
  nodes: Node<BuilderNodeData>[],
  edges: Edge<BuilderEdgeData>[],
  originalTemplate: ProtocolTemplate,
): ProtocolTemplate {
  const steps: ProtocolStepDefinition[] = nodes.map((node) => {
    const step: ProtocolStepDefinition = {
      id: node.id,
      kind: node.data.kind,
      label: node.data.label,
    }

    if (node.data.instructions) step.instructions = node.data.instructions
    if (node.data.turnLimit) step.turnLimit = node.data.turnLimit
    if (node.data.completionCriteria) step.completionCriteria = node.data.completionCriteria
    if (node.data.taskConfig) step.taskConfig = node.data.taskConfig
    if (node.data.delegationConfig) step.delegationConfig = node.data.delegationConfig
    if (node.data.repeat) step.repeat = node.data.repeat
    if (node.data.parallel) step.parallel = node.data.parallel
    if (node.data.join) step.join = node.data.join
    if (node.data.forEach) step.forEach = node.data.forEach
    if (node.data.subflow) step.subflow = node.data.subflow
    if (node.data.swarm) step.swarm = node.data.swarm
    if (node.data.branchCases?.length) step.branchCases = node.data.branchCases
    if (node.data.defaultNextStepId) step.defaultNextStepId = node.data.defaultNextStepId
    if (node.data.outputKey) step.outputKey = node.data.outputKey
    if (node.data.dependsOnStepIds?.length) step.dependsOnStepIds = node.data.dependsOnStepIds

    // Derive nextStepId from default edges
    const defaultEdge = edges.find(
      (e) => e.source === node.id && e.data?.edgeType === 'default',
    )
    if (defaultEdge) {
      step.nextStepId = defaultEdge.target
    }

    return step
  })

  return {
    ...originalTemplate,
    steps,
    entryStepId: nodes[0]?.id || originalTemplate.entryStepId,
  }
}
