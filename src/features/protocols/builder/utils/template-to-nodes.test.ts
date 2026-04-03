import { describe, it, expect } from 'vitest'
import { getNodeTypeForKind, templateToNodes } from './template-to-nodes'
import type { ProtocolTemplate, ProtocolStepDefinition, ProtocolPhaseDefinition } from '@/types'

// --- getNodeTypeForKind ---

describe('getNodeTypeForKind', () => {
  it('maps all ProtocolPhaseKind values to "phase"', () => {
    const phaseKinds = [
      'present',
      'collect_independent_inputs',
      'round_robin',
      'compare',
      'decide',
      'summarize',
      'emit_tasks',
      'wait',
      'dispatch_task',
      'dispatch_delegation',
    ] as const

    for (const kind of phaseKinds) {
      expect(getNodeTypeForKind(kind)).toBe('phase')
    }
  })

  it('maps branch to "branch"', () => {
    expect(getNodeTypeForKind('branch')).toBe('branch')
  })

  it('maps repeat to "loop"', () => {
    expect(getNodeTypeForKind('repeat')).toBe('loop')
  })

  it('maps parallel to "parallel"', () => {
    expect(getNodeTypeForKind('parallel')).toBe('parallel')
  })

  it('maps join to "join"', () => {
    expect(getNodeTypeForKind('join')).toBe('join')
  })

  it('maps complete to "complete"', () => {
    expect(getNodeTypeForKind('complete')).toBe('complete')
  })

  it('maps for_each to "forEach"', () => {
    expect(getNodeTypeForKind('for_each')).toBe('forEach')
  })

  it('maps subflow to "subflow"', () => {
    expect(getNodeTypeForKind('subflow')).toBe('subflow')
  })

  it('maps swarm_claim to "swarm"', () => {
    expect(getNodeTypeForKind('swarm_claim')).toBe('swarm')
  })
})

// --- templateToNodes ---

function makeTemplate(overrides: Partial<ProtocolTemplate> = {}): ProtocolTemplate {
  return {
    id: 'tpl-1',
    name: 'Test Template',
    description: 'A test template',
    builtIn: false,
    defaultPhases: [],
    ...overrides,
  }
}

function makeStep(overrides: Partial<ProtocolStepDefinition> = {}): ProtocolStepDefinition {
  return {
    id: 'step-1',
    kind: 'present',
    label: 'Step One',
    ...overrides,
  }
}

describe('templateToNodes — node creation', () => {
  it('creates one node per step', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({ id: 'step-1', label: 'Step One' }),
      makeStep({ id: 'step-2', label: 'Step Two', kind: 'decide' }),
    ]
    const { nodes } = templateToNodes(makeTemplate({ steps }))
    expect(nodes).toHaveLength(2)
    expect(nodes.map((n) => n.id)).toEqual(['step-1', 'step-2'])
  })

  it('sets correct node type from kind', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({ id: 'phase-step', kind: 'present' }),
      makeStep({ id: 'branch-step', kind: 'branch' }),
      makeStep({ id: 'loop-step', kind: 'repeat' }),
      makeStep({ id: 'parallel-step', kind: 'parallel' }),
      makeStep({ id: 'join-step', kind: 'join' }),
      makeStep({ id: 'complete-step', kind: 'complete' }),
      makeStep({ id: 'foreach-step', kind: 'for_each' }),
      makeStep({ id: 'subflow-step', kind: 'subflow' }),
      makeStep({ id: 'swarm-step', kind: 'swarm_claim' }),
    ]
    const { nodes } = templateToNodes(makeTemplate({ steps }))
    const typeMap = Object.fromEntries(nodes.map((n) => [n.id, n.type]))
    expect(typeMap['phase-step']).toBe('phase')
    expect(typeMap['branch-step']).toBe('branch')
    expect(typeMap['loop-step']).toBe('loop')
    expect(typeMap['parallel-step']).toBe('parallel')
    expect(typeMap['join-step']).toBe('join')
    expect(typeMap['complete-step']).toBe('complete')
    expect(typeMap['foreach-step']).toBe('forEach')
    expect(typeMap['subflow-step']).toBe('subflow')
    expect(typeMap['swarm-step']).toBe('swarm')
  })

  it('copies step data fields into node data', () => {
    const step = makeStep({
      id: 'step-1',
      kind: 'decide',
      label: 'My Step',
      instructions: 'Do the thing',
      turnLimit: 3,
      completionCriteria: 'Done when X',
      outputKey: 'result',
      dependsOnStepIds: ['step-0'],
    })
    const { nodes } = templateToNodes(makeTemplate({ steps: [step] }))
    const data = nodes[0].data
    expect(data.label).toBe('My Step')
    expect(data.kind).toBe('decide')
    expect(data.instructions).toBe('Do the thing')
    expect(data.turnLimit).toBe(3)
    expect(data.completionCriteria).toBe('Done when X')
    expect(data.outputKey).toBe('result')
    expect(data.dependsOnStepIds).toEqual(['step-0'])
  })
})

describe('templateToNodes — edge creation', () => {
  it('creates a default edge from nextStepId', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({ id: 'step-1', nextStepId: 'step-2' }),
      makeStep({ id: 'step-2' }),
    ]
    const { edges } = templateToNodes(makeTemplate({ steps }))
    expect(edges).toHaveLength(1)
    const edge = edges[0]
    expect(edge.id).toBe('step-1--step-2')
    expect(edge.source).toBe('step-1')
    expect(edge.target).toBe('step-2')
    expect(edge.type).toBe('default')
    expect(edge.data?.edgeType).toBe('default')
  })

  it('creates branch edges from branchCases', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({
        id: 'branch-step',
        kind: 'branch',
        branchCases: [
          { id: 'case-yes', label: 'Yes', nextStepId: 'step-yes' },
          { id: 'case-no', label: 'No', nextStepId: 'step-no' },
        ],
      }),
      makeStep({ id: 'step-yes' }),
      makeStep({ id: 'step-no' }),
    ]
    const { edges } = templateToNodes(makeTemplate({ steps }))
    const branchEdges = edges.filter((e) => e.data?.edgeType === 'branch')
    expect(branchEdges).toHaveLength(2)

    const yesEdge = branchEdges.find((e) => e.id === 'branch-step--case-yes')
    expect(yesEdge).toBeDefined()
    expect(yesEdge?.source).toBe('branch-step')
    expect(yesEdge?.target).toBe('step-yes')
    expect(yesEdge?.sourceHandle).toBe('case-yes')
    expect(yesEdge?.data?.branchCaseId).toBe('case-yes')
    expect(yesEdge?.data?.label).toBe('Yes')

    const noEdge = branchEdges.find((e) => e.id === 'branch-step--case-no')
    expect(noEdge).toBeDefined()
    expect(noEdge?.target).toBe('step-no')
  })

  it('creates a branch edge for defaultNextStepId with label "Default"', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({
        id: 'branch-step',
        kind: 'branch',
        branchCases: [
          { id: 'case-a', label: 'Option A', nextStepId: 'step-a' },
        ],
        defaultNextStepId: 'step-default',
      }),
      makeStep({ id: 'step-a' }),
      makeStep({ id: 'step-default' }),
    ]
    const { edges } = templateToNodes(makeTemplate({ steps }))
    const defaultEdge = edges.find((e) => e.id === 'branch-step--default')
    expect(defaultEdge).toBeDefined()
    expect(defaultEdge?.source).toBe('branch-step')
    expect(defaultEdge?.target).toBe('step-default')
    expect(defaultEdge?.sourceHandle).toBe('default')
    expect(defaultEdge?.type).toBe('branch')
    expect(defaultEdge?.label).toBe('Default')
    expect(defaultEdge?.data?.edgeType).toBe('branch')
    expect(defaultEdge?.data?.label).toBe('Default')
  })

  it('creates a loop edge from repeat.bodyStepId', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({
        id: 'loop-step',
        kind: 'repeat',
        repeat: {
          bodyStepId: 'body-step',
          maxIterations: 5,
        },
      }),
      makeStep({ id: 'body-step' }),
    ]
    const { edges } = templateToNodes(makeTemplate({ steps }))
    const loopEdge = edges.find((e) => e.id === 'loop-step--loop')
    expect(loopEdge).toBeDefined()
    expect(loopEdge?.source).toBe('loop-step')
    expect(loopEdge?.target).toBe('body-step')
    expect(loopEdge?.sourceHandle).toBe('loop-back')
    expect(loopEdge?.type).toBe('loop')
    expect(loopEdge?.data?.edgeType).toBe('loop')
    expect(loopEdge?.data?.isLoopback).toBe(true)
  })

  it('creates no edges when steps have no connections', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({ id: 'step-1' }),
      makeStep({ id: 'step-2' }),
    ]
    const { edges } = templateToNodes(makeTemplate({ steps }))
    expect(edges).toHaveLength(0)
  })
})

describe('templateToNodes — fallback to defaultPhases', () => {
  it('uses defaultPhases when steps is undefined', () => {
    const phases: ProtocolPhaseDefinition[] = [
      { id: 'phase-1', kind: 'present', label: 'Present' },
      { id: 'phase-2', kind: 'decide', label: 'Decide' },
    ]
    const { nodes } = templateToNodes(makeTemplate({ defaultPhases: phases }))
    expect(nodes).toHaveLength(2)
    expect(nodes[0].id).toBe('phase-1')
    expect(nodes[1].id).toBe('phase-2')
  })

  it('uses defaultPhases when steps is an empty array', () => {
    const phases: ProtocolPhaseDefinition[] = [
      { id: 'phase-1', kind: 'summarize', label: 'Summarize' },
    ]
    const { nodes } = templateToNodes(makeTemplate({ defaultPhases: phases, steps: [] }))
    expect(nodes).toHaveLength(1)
    expect(nodes[0].id).toBe('phase-1')
  })

  it('creates sequential edges between defaultPhases', () => {
    const phases: ProtocolPhaseDefinition[] = [
      { id: 'phase-1', kind: 'present', label: 'Present' },
      { id: 'phase-2', kind: 'decide', label: 'Decide' },
      { id: 'phase-3', kind: 'summarize', label: 'Summarize' },
    ]
    const { edges } = templateToNodes(makeTemplate({ defaultPhases: phases }))
    expect(edges).toHaveLength(2)
    expect(edges[0].id).toBe('phase-1--phase-2')
    expect(edges[0].source).toBe('phase-1')
    expect(edges[0].target).toBe('phase-2')
    expect(edges[1].id).toBe('phase-2--phase-3')
    expect(edges[1].source).toBe('phase-2')
    expect(edges[1].target).toBe('phase-3')
  })

  it('copies phase data fields into node data', () => {
    const phases: ProtocolPhaseDefinition[] = [
      {
        id: 'phase-1',
        kind: 'present',
        label: 'Present Phase',
        instructions: 'Do the presentation',
        turnLimit: 2,
        completionCriteria: 'All presented',
      },
    ]
    const { nodes } = templateToNodes(makeTemplate({ defaultPhases: phases }))
    const data = nodes[0].data
    expect(data.label).toBe('Present Phase')
    expect(data.kind).toBe('present')
    expect(data.instructions).toBe('Do the presentation')
    expect(data.turnLimit).toBe(2)
    expect(data.completionCriteria).toBe('All presented')
  })

  it('uses steps when both steps and defaultPhases are present and steps is non-empty', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({ id: 'step-1', label: 'The Step' }),
    ]
    const phases: ProtocolPhaseDefinition[] = [
      { id: 'phase-1', kind: 'present', label: 'The Phase' },
    ]
    const { nodes } = templateToNodes(makeTemplate({ steps, defaultPhases: phases }))
    expect(nodes).toHaveLength(1)
    expect(nodes[0].id).toBe('step-1')
  })
})
