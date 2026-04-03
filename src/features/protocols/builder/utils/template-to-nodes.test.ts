import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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
      assert.strictEqual(getNodeTypeForKind(kind), 'phase')
    }
  })

  it('maps branch to "branch"', () => {
    assert.strictEqual(getNodeTypeForKind('branch'), 'branch')
  })

  it('maps repeat to "loop"', () => {
    assert.strictEqual(getNodeTypeForKind('repeat'), 'loop')
  })

  it('maps parallel to "parallel"', () => {
    assert.strictEqual(getNodeTypeForKind('parallel'), 'parallel')
  })

  it('maps join to "join"', () => {
    assert.strictEqual(getNodeTypeForKind('join'), 'join')
  })

  it('maps complete to "complete"', () => {
    assert.strictEqual(getNodeTypeForKind('complete'), 'complete')
  })

  it('maps for_each to "forEach"', () => {
    assert.strictEqual(getNodeTypeForKind('for_each'), 'forEach')
  })

  it('maps subflow to "subflow"', () => {
    assert.strictEqual(getNodeTypeForKind('subflow'), 'subflow')
  })

  it('maps swarm_claim to "swarm"', () => {
    assert.strictEqual(getNodeTypeForKind('swarm_claim'), 'swarm')
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
    assert.strictEqual(nodes.length, 2)
    assert.deepStrictEqual(nodes.map((n) => n.id), ['step-1', 'step-2'])
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
    assert.strictEqual(typeMap['phase-step'], 'phase')
    assert.strictEqual(typeMap['branch-step'], 'branch')
    assert.strictEqual(typeMap['loop-step'], 'loop')
    assert.strictEqual(typeMap['parallel-step'], 'parallel')
    assert.strictEqual(typeMap['join-step'], 'join')
    assert.strictEqual(typeMap['complete-step'], 'complete')
    assert.strictEqual(typeMap['foreach-step'], 'forEach')
    assert.strictEqual(typeMap['subflow-step'], 'subflow')
    assert.strictEqual(typeMap['swarm-step'], 'swarm')
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
    assert.strictEqual(data.label, 'My Step')
    assert.strictEqual(data.kind, 'decide')
    assert.strictEqual(data.instructions, 'Do the thing')
    assert.strictEqual(data.turnLimit, 3)
    assert.strictEqual(data.completionCriteria, 'Done when X')
    assert.strictEqual(data.outputKey, 'result')
    assert.deepStrictEqual(data.dependsOnStepIds, ['step-0'])
  })
})

describe('templateToNodes — edge creation', () => {
  it('creates a default edge from nextStepId', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({ id: 'step-1', nextStepId: 'step-2' }),
      makeStep({ id: 'step-2' }),
    ]
    const { edges } = templateToNodes(makeTemplate({ steps }))
    assert.strictEqual(edges.length, 1)
    const edge = edges[0]
    assert.strictEqual(edge.id, 'step-1--step-2')
    assert.strictEqual(edge.source, 'step-1')
    assert.strictEqual(edge.target, 'step-2')
    assert.strictEqual(edge.type, 'default')
    assert.strictEqual(edge.data?.edgeType, 'default')
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
    assert.strictEqual(branchEdges.length, 2)

    const yesEdge = branchEdges.find((e) => e.id === 'branch-step--case-yes')
    assert.notStrictEqual(yesEdge, undefined)
    assert.strictEqual(yesEdge?.source, 'branch-step')
    assert.strictEqual(yesEdge?.target, 'step-yes')
    assert.strictEqual(yesEdge?.sourceHandle, 'case-yes')
    assert.strictEqual(yesEdge?.data?.branchCaseId, 'case-yes')
    assert.strictEqual(yesEdge?.data?.label, 'Yes')

    const noEdge = branchEdges.find((e) => e.id === 'branch-step--case-no')
    assert.notStrictEqual(noEdge, undefined)
    assert.strictEqual(noEdge?.target, 'step-no')
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
    assert.notStrictEqual(defaultEdge, undefined)
    assert.strictEqual(defaultEdge?.source, 'branch-step')
    assert.strictEqual(defaultEdge?.target, 'step-default')
    assert.strictEqual(defaultEdge?.sourceHandle, 'default')
    assert.strictEqual(defaultEdge?.type, 'branch')
    assert.strictEqual(defaultEdge?.label, 'Default')
    assert.strictEqual(defaultEdge?.data?.edgeType, 'branch')
    assert.strictEqual(defaultEdge?.data?.label, 'Default')
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
    assert.notStrictEqual(loopEdge, undefined)
    assert.strictEqual(loopEdge?.source, 'loop-step')
    assert.strictEqual(loopEdge?.target, 'body-step')
    assert.strictEqual(loopEdge?.sourceHandle, 'loop-back')
    assert.strictEqual(loopEdge?.type, 'loop')
    assert.strictEqual(loopEdge?.data?.edgeType, 'loop')
    assert.strictEqual(loopEdge?.data?.isLoopback, true)
  })

  it('creates no edges when steps have no connections', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({ id: 'step-1' }),
      makeStep({ id: 'step-2' }),
    ]
    const { edges } = templateToNodes(makeTemplate({ steps }))
    assert.strictEqual(edges.length, 0)
  })
})

describe('templateToNodes — fallback to defaultPhases', () => {
  it('uses defaultPhases when steps is undefined', () => {
    const phases: ProtocolPhaseDefinition[] = [
      { id: 'phase-1', kind: 'present', label: 'Present' },
      { id: 'phase-2', kind: 'decide', label: 'Decide' },
    ]
    const { nodes } = templateToNodes(makeTemplate({ defaultPhases: phases }))
    assert.strictEqual(nodes.length, 2)
    assert.strictEqual(nodes[0].id, 'phase-1')
    assert.strictEqual(nodes[1].id, 'phase-2')
  })

  it('uses defaultPhases when steps is an empty array', () => {
    const phases: ProtocolPhaseDefinition[] = [
      { id: 'phase-1', kind: 'summarize', label: 'Summarize' },
    ]
    const { nodes } = templateToNodes(makeTemplate({ defaultPhases: phases, steps: [] }))
    assert.strictEqual(nodes.length, 1)
    assert.strictEqual(nodes[0].id, 'phase-1')
  })

  it('creates sequential edges between defaultPhases', () => {
    const phases: ProtocolPhaseDefinition[] = [
      { id: 'phase-1', kind: 'present', label: 'Present' },
      { id: 'phase-2', kind: 'decide', label: 'Decide' },
      { id: 'phase-3', kind: 'summarize', label: 'Summarize' },
    ]
    const { edges } = templateToNodes(makeTemplate({ defaultPhases: phases }))
    assert.strictEqual(edges.length, 2)
    assert.strictEqual(edges[0].id, 'phase-1--phase-2')
    assert.strictEqual(edges[0].source, 'phase-1')
    assert.strictEqual(edges[0].target, 'phase-2')
    assert.strictEqual(edges[1].id, 'phase-2--phase-3')
    assert.strictEqual(edges[1].source, 'phase-2')
    assert.strictEqual(edges[1].target, 'phase-3')
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
    assert.strictEqual(data.label, 'Present Phase')
    assert.strictEqual(data.kind, 'present')
    assert.strictEqual(data.instructions, 'Do the presentation')
    assert.strictEqual(data.turnLimit, 2)
    assert.strictEqual(data.completionCriteria, 'All presented')
  })

  it('uses steps when both steps and defaultPhases are present and steps is non-empty', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({ id: 'step-1', label: 'The Step' }),
    ]
    const phases: ProtocolPhaseDefinition[] = [
      { id: 'phase-1', kind: 'present', label: 'The Phase' },
    ]
    const { nodes } = templateToNodes(makeTemplate({ steps, defaultPhases: phases }))
    assert.strictEqual(nodes.length, 1)
    assert.strictEqual(nodes[0].id, 'step-1')
  })
})
