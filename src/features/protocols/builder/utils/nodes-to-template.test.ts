import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ProtocolTemplate, ProtocolStepDefinition } from '@/types'
import { templateToNodes } from './template-to-nodes'
import { nodesToTemplate } from './nodes-to-template'

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

// --- Round-trip: templateToNodes → nodesToTemplate ---

describe('nodesToTemplate — round-trip', () => {
  it('round-trips a simple 3-step template: preserves step count and entryStepId', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({ id: 'step-1', label: 'Step One', nextStepId: 'step-2' }),
      makeStep({ id: 'step-2', label: 'Step Two', kind: 'decide', nextStepId: 'step-3' }),
      makeStep({ id: 'step-3', label: 'Step Three', kind: 'summarize' }),
    ]
    const template = makeTemplate({ steps, entryStepId: 'step-1' })
    const { nodes, edges } = templateToNodes(template)
    const result = nodesToTemplate(nodes, edges, template)

    assert.strictEqual(result.steps!.length, 3)
    assert.deepStrictEqual(result.steps!.map((s) => s.id), ['step-1', 'step-2', 'step-3'])
    assert.strictEqual(result.entryStepId, 'step-1')
  })

  it('preserves nextStepId from default edges', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({ id: 'step-a', nextStepId: 'step-b' }),
      makeStep({ id: 'step-b', nextStepId: 'step-c' }),
      makeStep({ id: 'step-c' }),
    ]
    const template = makeTemplate({ steps })
    const { nodes, edges } = templateToNodes(template)
    const result = nodesToTemplate(nodes, edges, template)

    const stepA = result.steps!.find((s) => s.id === 'step-a')
    const stepB = result.steps!.find((s) => s.id === 'step-b')
    const stepC = result.steps!.find((s) => s.id === 'step-c')

    assert.strictEqual(stepA?.nextStepId, 'step-b')
    assert.strictEqual(stepB?.nextStepId, 'step-c')
    assert.strictEqual(stepC?.nextStepId, undefined)
  })

  it('preserves step data fields: instructions, turnLimit, completionCriteria, outputKey', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({
        id: 'step-rich',
        kind: 'decide',
        label: 'Rich Step',
        instructions: 'Evaluate carefully',
        turnLimit: 5,
        completionCriteria: 'Decision made',
        outputKey: 'decision_result',
        dependsOnStepIds: ['step-prev'],
      }),
    ]
    const template = makeTemplate({ steps })
    const { nodes, edges } = templateToNodes(template)
    const result = nodesToTemplate(nodes, edges, template)

    const step = result.steps![0]
    assert.strictEqual(step.id, 'step-rich')
    assert.strictEqual(step.kind, 'decide')
    assert.strictEqual(step.label, 'Rich Step')
    assert.strictEqual(step.instructions, 'Evaluate carefully')
    assert.strictEqual(step.turnLimit, 5)
    assert.strictEqual(step.completionCriteria, 'Decision made')
    assert.strictEqual(step.outputKey, 'decision_result')
    assert.deepStrictEqual(step.dependsOnStepIds, ['step-prev'])
  })

  it('preserves branchCases and defaultNextStepId', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({
        id: 'branch-step',
        kind: 'branch',
        label: 'Branch',
        branchCases: [
          { id: 'case-yes', label: 'Yes', nextStepId: 'step-yes' },
          { id: 'case-no', label: 'No', nextStepId: 'step-no' },
        ],
        defaultNextStepId: 'step-default',
      }),
      makeStep({ id: 'step-yes', label: 'Yes Path' }),
      makeStep({ id: 'step-no', label: 'No Path' }),
      makeStep({ id: 'step-default', label: 'Default Path' }),
    ]
    const template = makeTemplate({ steps })
    const { nodes, edges } = templateToNodes(template)
    const result = nodesToTemplate(nodes, edges, template)

    const branch = result.steps!.find((s) => s.id === 'branch-step')
    assert.strictEqual(branch?.branchCases!.length, 2)
    assert.strictEqual(branch?.branchCases![0].id, 'case-yes')
    assert.strictEqual(branch?.branchCases![0].nextStepId, 'step-yes')
    assert.strictEqual(branch?.branchCases![1].id, 'case-no')
    assert.strictEqual(branch?.branchCases![1].nextStepId, 'step-no')
    assert.strictEqual(branch?.defaultNextStepId, 'step-default')
  })

  it('sets entryStepId from the first node', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({ id: 'first-step', label: 'First' }),
      makeStep({ id: 'second-step', label: 'Second' }),
    ]
    const template = makeTemplate({ steps, entryStepId: 'first-step' })
    const { nodes, edges } = templateToNodes(template)
    const result = nodesToTemplate(nodes, edges, template)

    assert.strictEqual(result.entryStepId, nodes[0].id)
    assert.strictEqual(result.entryStepId, 'first-step')
  })
})

// --- Direct nodesToTemplate tests (no round-trip) ---

describe('nodesToTemplate — direct construction', () => {
  it('preserves all originalTemplate fields except steps and entryStepId', () => {
    const template = makeTemplate({
      id: 'custom-id',
      name: 'Custom Name',
      description: 'Custom description',
      builtIn: true,
      tags: ['tag-a', 'tag-b'],
      singleAgentAllowed: true,
      steps: [makeStep({ id: 'step-x' })],
    })
    const { nodes, edges } = templateToNodes(template)
    const result = nodesToTemplate(nodes, edges, template)

    assert.strictEqual(result.id, 'custom-id')
    assert.strictEqual(result.name, 'Custom Name')
    assert.strictEqual(result.description, 'Custom description')
    assert.strictEqual(result.builtIn, true)
    assert.deepStrictEqual(result.tags, ['tag-a', 'tag-b'])
    assert.strictEqual(result.singleAgentAllowed, true)
  })

  it('handles an empty nodes array without throwing', () => {
    const template = makeTemplate({ steps: [makeStep({ id: 'step-1' })], entryStepId: 'step-1' })
    const result = nodesToTemplate([], [], template)

    assert.strictEqual(result.steps!.length, 0)
    // entryStepId falls back to originalTemplate.entryStepId when nodes is empty
    assert.strictEqual(result.entryStepId, 'step-1')
  })

  it('does not include nextStepId on steps with no outgoing default edge', () => {
    const steps: ProtocolStepDefinition[] = [
      makeStep({ id: 'lone-step', label: 'Lone Step' }),
    ]
    const template = makeTemplate({ steps })
    const { nodes, edges } = templateToNodes(template)
    const result = nodesToTemplate(nodes, edges, template)

    const step = result.steps![0]
    assert.strictEqual(step.nextStepId, undefined)
  })
})
